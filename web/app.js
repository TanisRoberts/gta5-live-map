/*
 * GTA V Live Map — web client.
 *
 * Vanilla JS + Leaflet (CRS.Simple). No build step, no framework.
 *
 * Coordinate spaces
 * -----------------
 *   game    (x, y)      GTA world units. +X east, +Y north.
 *   leaflet (lat, lng)  CRS.Simple. The image overlay is placed with bounds
 *                       [[0,0],[h,w]], so lng runs 0..width left-to-right and
 *                       lat runs 0..height BOTTOM-to-top. Raw image pixel rows
 *                       count downward, which is the "game Y is inverted vs
 *                       image Y" gotcha — placing the overlay this way absorbs
 *                       it, and the two-point solve below would recover the
 *                       sign anyway.
 *
 * The transform is axis-independent scale + offset (no rotation or shear):
 *
 *   lng = a * gameX + b
 *   lat = c * gameY + d
 */
'use strict';

(function () {

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const POLL_MS        = 100;   // ~10 Hz
const MOCK_MS        = 50;    // ~20 Hz, matching the plugin's tick throttle
const RENDER_DELAY_MS = 250;  // interpolate this far behind live, so we never
                              // extrapolate past the newest sample
const BUFFER_MS      = 5000;  // how much history to keep for interpolation
const STALE_MS       = 1500;  // no sample this long => feed considered dead
const FETCH_TIMEOUT  = 2000;
const TRAIL_MIN_MOVE = 3;     // game units between trail points
const LS_KEY         = 'gta5livemap.settings';
const DB_NAME        = 'gta5-live-map';
const DB_STORE       = 'assets';
const DB_KEY         = 'mapImage';

// --------------------------------------------------------------------------
// Tiny helpers
// --------------------------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const lerp = (a, b, u) => a + (b - a) * u;

/** Interpolate degrees along the shortest arc. */
function lerpAngle(a, b, u) {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * u;
}

/** Direction vector in game space -> GTA heading (0 = north, CCW positive). */
function dirToHeading(dx, dy) {
  return (Math.atan2(-dx, dy) * 180 / Math.PI + 360) % 360;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// --------------------------------------------------------------------------
// Settings (localStorage)
// --------------------------------------------------------------------------
const defaults = {
  transform:   null,     // { a, b, c, d }
  follow:      true,
  trailLength: 400,
  mock:        false,
  server:      '',
  panelOpen:   null      // null = decide from viewport width on first run
};

let settings = load();

function load() {
  try {
    return Object.assign({}, defaults, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  } catch {
    return Object.assign({}, defaults);
  }
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Could not persist settings:', e);
  }
}

// --------------------------------------------------------------------------
// Map image storage (IndexedDB)
// --------------------------------------------------------------------------
function idbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror   = () => rej(rq.error);
  });
}

async function idbPut(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const rq = tx.objectStore(DB_STORE).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror   = () => rej(rq.error);
  });
}

// --------------------------------------------------------------------------
// Transform
// --------------------------------------------------------------------------
/** Solve scale+offset per axis from two correspondences. */
function solveTransform(p0, p1) {
  const dx = p1.game.x - p0.game.x;
  const dy = p1.game.y - p0.game.y;
  if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) return null;
  const a = (p1.img.lng - p0.img.lng) / dx;
  const c = (p1.img.lat - p0.img.lat) / dy;
  return { a, b: p0.img.lng - a * p0.game.x, c, d: p0.img.lat - c * p0.game.y };
}

function gameToLatLng(x, y) {
  const t = settings.transform;
  if (!t) return null;
  return L.latLng(t.c * y + t.d, t.a * x + t.b);
}

/**
 * Player heading -> CSS rotation in degrees (clockwise from "up").
 *
 * The heading is pushed through the transform rather than used raw, so the
 * arrow points along the path as actually drawn. That matters because the X
 * and Y scales are solved independently: if they come out unequal the image
 * is anisotropically stretched, and a direction vector rotates with it. Signs
 * fall out of the same maths, so a mirrored or flipped image also works.
 */
function headingToCssDeg(heading) {
  const t = settings.transform;
  const a = t ? t.a : 1;
  const c = t ? t.c : 1;
  const r = heading * Math.PI / 180;
  // Game-space direction (-sin, cos) -> screen: x by `a`, "up" by `c`.
  return Math.atan2(a * -Math.sin(r), c * Math.cos(r)) * 180 / Math.PI;
}

// --------------------------------------------------------------------------
// Sample buffer + clock sync
// --------------------------------------------------------------------------
/*
 * Samples carry the producer's own monotonic timestamp `t`. We estimate the
 * offset between that clock and ours with a running minimum (the sample that
 * took the least time to reach us is the least delayed), nudged slowly upward
 * so the estimate can follow real drift. Interpolating on producer time rather
 * than arrival time keeps network jitter out of the marker's motion.
 */
let buf = [];
let clockOffset = null;
let lastSampleT = -Infinity;
let lastGoodAt  = -Infinity;

function pushSample(s) {
  if (!s || typeof s.x !== 'number' || typeof s.t !== 'number') return;
  if (s.t <= lastSampleT) return;                   // dedupe / out-of-order
  lastSampleT = s.t;

  const now = performance.now();
  const off = now - s.t;
  if (clockOffset === null || off < clockOffset) clockOffset = off;
  else clockOffset += (off - clockOffset) * 0.002;

  s.lt = s.t + clockOffset;
  buf.push(s);
  lastGoodAt = now;

  const cutoff = now - BUFFER_MS;
  while (buf.length > 2 && buf[0].lt < cutoff) buf.shift();
}

function resetBuffer() {
  buf = [];
  clockOffset = null;
  lastSampleT = -Infinity;
  lastGoodAt  = -Infinity;
}

/** Interpolated state at a point on our local clock, or null. */
function sampleAt(tLocal) {
  if (!buf.length) return null;
  if (buf.length === 1 || tLocal <= buf[0].lt) return buf[0];
  const last = buf[buf.length - 1];
  if (tLocal >= last.lt) return last;

  let i = buf.length - 2;
  while (i > 0 && buf[i].lt > tLocal) i--;
  const p = buf[i], q = buf[i + 1];
  const span = q.lt - p.lt;
  const u = span > 0 ? (tLocal - p.lt) / span : 0;

  return {
    x: lerp(p.x, q.x, u),
    y: lerp(p.y, q.y, u),
    z: lerp(p.z, q.z, u),
    heading: lerpAngle(p.heading, q.heading, u),
    speed:   lerp(p.speed, q.speed, u),
    inVehicle:          q.inVehicle,
    vehicleDisplayName: q.vehicleDisplayName,
    wantedLevel:        q.wantedLevel,
    gameHour:           q.gameHour,
    gameMinute:         q.gameMinute
  };
}

// --------------------------------------------------------------------------
// Feed: HTTP polling
// --------------------------------------------------------------------------
let pollTimer = null;
let inFlight  = false;

function posUrl() {
  const base = (settings.server || '').trim().replace(/\/+$/, '');
  return base + '/pos';
}

let feedError = null;
let failures  = 0;
let nextTryAt = 0;

async function pollOnce() {
  // Back off while the endpoint is down, so a missing plugin doesn't hammer it
  // (and the console) ten times a second.
  if (inFlight || performance.now() < nextTryAt) return;
  inFlight = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(posUrl(), { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    pushSample(await r.json());
    feedError = null;
    failures  = 0;
    nextTryAt = 0;
  } catch (e) {
    feedError = e.name === 'AbortError' ? 'timed out' : String(e.message || e);
    failures++;
    nextTryAt = performance.now() + Math.min(2000, POLL_MS * Math.pow(2, Math.min(failures, 5)));
  } finally {
    clearTimeout(timer);
    inFlight = false;
  }
}

// --------------------------------------------------------------------------
// Feed: mock
// --------------------------------------------------------------------------
/*
 * Drives the marker around a lumpy circular loop so the whole UI — calibration,
 * follow mode, trail, HUD, interpolation — is testable with the game shut.
 * Heading comes from the numeric velocity, so it is always consistent with the
 * path actually travelled.
 */
const MOCK_VEHICLES = ['Sultan', 'Buffalo STX', null, 'Sanchez', 'Bison', null];
const MOCK_PHASE_MS = 30000;

let mockTimer   = null;
let mockPrev    = null;
let mockTheta   = 0;
let mockHeading = 0;

function mockPos(theta) {
  const R = 1400 * (1 + 0.12 * Math.sin(3 * theta));
  return { x: 200 + R * Math.cos(theta), y: 200 + R * Math.sin(theta), R };
}

function mockTick() {
  const t = performance.now();
  const dt = mockPrev ? Math.min((t - mockPrev.t) / 1000, 0.25) : 0;

  // Advance along the loop at a plausible ground speed, so the reported speed
  // and the distance actually covered always agree.
  const veh = MOCK_VEHICLES[Math.floor(t / MOCK_PHASE_MS) % MOCK_VEHICLES.length];
  const target = veh ? 24 + 12 * Math.sin(t / 7000) : 1.9;   // m/s
  mockTheta += (target * dt) / mockPos(mockTheta).R;

  const p = mockPos(mockTheta);

  let speed = 0;
  if (mockPrev && dt > 0) {
    const dx = p.x - mockPrev.x, dy = p.y - mockPrev.y;
    speed = Math.hypot(dx, dy) / dt;
    if (speed > 0.05) mockHeading = dirToHeading(dx, dy);
  }
  mockPrev = { t, x: p.x, y: p.y };

  const gameMinutes = Math.floor(t / 2000) % 1440;           // 30x real time

  pushSample({
    x: p.x,
    y: p.y,
    z: 30 + 25 * Math.sin(mockTheta * 2),
    heading: mockHeading,
    speed,
    inVehicle: !!veh,
    vehicleDisplayName: veh,
    wantedLevel: Math.floor(t / 25000) % 6,
    gameHour:   Math.floor(gameMinutes / 60),
    gameMinute: gameMinutes % 60,
    t
  });
}

// --------------------------------------------------------------------------
// Feed control
// --------------------------------------------------------------------------
function startFeed() {
  stopFeed();
  resetBuffer();
  feedError = null;
  failures  = 0;
  nextTryAt = 0;
  mockPrev  = null;
  if (settings.mock) mockTimer = setInterval(mockTick, MOCK_MS);
  else               pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopFeed() {
  clearInterval(pollTimer); pollTimer = null;
  clearInterval(mockTimer); mockTimer = null;
}

function updateFeedStatus() {
  const dot = $('#feedDot'), txt = $('#feedStatus');
  const fresh = performance.now() - lastGoodAt < STALE_MS;
  dot.className = 'dot';
  if (settings.mock) {
    dot.classList.add('mock');
    txt.textContent = 'Mock feed';
  } else if (fresh) {
    dot.classList.add('live');
    txt.textContent = 'Live — ' + (posUrl() || '/pos');
  } else {
    dot.classList.add('err');
    txt.textContent = 'No data' + (feedError ? ' (' + feedError + ')' : '');
  }
}

// --------------------------------------------------------------------------
// Map
// --------------------------------------------------------------------------
let map, overlay, imageBounds = null, imageSize = null;
let marker = null, markerSvg = null;
let trailLine = null;
let trailPts = [];          // game-space points
let calLayer = null;

function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -8,
    maxZoom: 6,
    zoomControl: true,
    attributionControl: false,
    zoomSnap: 0.25,
    preferCanvas: true
  });
  map.setView([0, 0], 0);

  calLayer  = L.layerGroup().addTo(map);
  trailLine = L.polyline([], {
    color: '#47c1ff', weight: 2.5, opacity: 0.65, interactive: false
  }).addTo(map);

  // Panning by hand means you want manual control.
  map.on('dragstart', () => { if (settings.follow) setFollow(false); });
  map.on('click', onMapClick);

  // Window resize, phone rotation, panel show/hide — Leaflet caches the
  // container size and needs telling.
  const onResize = () => {
    map.invalidateSize({ animate: false });
    if (!settings.transform && imageBounds) map.fitBounds(imageBounds);
  };
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe($('#map'));
}

async function setMapImage(blob, name) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload  = res;
    img.onerror = () => rej(new Error('That file could not be decoded as an image.'));
    img.src = url;
  });

  const w = img.naturalWidth, h = img.naturalHeight;
  imageBounds = L.latLngBounds([[0, 0], [h, w]]);
  imageSize   = { w, h };

  if (overlay) overlay.remove();
  overlay = L.imageOverlay(url, imageBounds).addTo(map);
  overlay.bringToBack();

  map.setMaxBounds(imageBounds.pad(0.6));
  map.setMinZoom(map.getBoundsZoom(imageBounds) - 3);
  if (!settings.transform) map.fitBounds(imageBounds);

  $('#imgInfo').textContent = `${name || 'image'} — ${w} × ${h} px`;
  $('#setup').hidden = true;
}

async function pickImage(file) {
  if (!file) return;
  try {
    await setMapImage(file, file.name);
  } catch (e) {
    toast(e.message || 'Could not load that image.');
    return;
  }
  try {
    await idbPut(DB_KEY, { blob: file, name: file.name });
  } catch (e) {
    console.warn('IndexedDB unavailable:', e);
    toast('Image loaded, but it could not be saved for next time. ' +
          'Serve this page over http:// rather than opening the file directly.', 6000);
  }
}

// --------------------------------------------------------------------------
// Render loop
// --------------------------------------------------------------------------
function ensureMarker() {
  if (marker) return;
  marker = L.marker([0, 0], {
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
    icon: L.divIcon({
      className: '',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      html: '<div class="player-marker"><svg viewBox="0 0 24 24">' +
            '<path class="body" d="M12 2 L20 21 L12 16.5 L4 21 Z"/></svg></div>'
    })
  }).addTo(map);
}

function redrawTrail() {
  if (!settings.transform) { trailLine.setLatLngs([]); return; }
  trailLine.setLatLngs(trailPts.map(p => gameToLatLng(p.x, p.y)));
}

function pushTrail(x, y) {
  const n = settings.trailLength;
  if (n <= 0) {
    if (trailPts.length) { trailPts = []; trailLine.setLatLngs([]); }
    return;
  }
  const last = trailPts[trailPts.length - 1];
  if (last && Math.hypot(x - last.x, y - last.y) < TRAIL_MIN_MOVE) return;
  trailPts.push({ x, y });
  while (trailPts.length > n) trailPts.shift();
  redrawTrail();
}

let current = null;   // most recent interpolated state, for the HUD

function frame() {
  requestAnimationFrame(frame);
  const s = sampleAt(performance.now() - RENDER_DELAY_MS);
  if (!s) return;
  current = s;

  const ll = gameToLatLng(s.x, s.y);
  if (!ll) return;

  ensureMarker();
  marker.setLatLng(ll);

  if (!markerSvg && marker.getElement()) markerSvg = marker.getElement().querySelector('svg');
  if (markerSvg) markerSvg.style.transform = `rotate(${headingToCssDeg(s.heading).toFixed(1)}deg)`;

  pushTrail(s.x, s.y);

  if (settings.follow) map.setView(ll, map.getZoom(), { animate: false });
}

function updateHud() {
  updateFeedStatus();
  const s = current;
  if (!s) return;
  $('#hudSpeed').textContent   = Math.round(s.speed * 2.23694);      // m/s -> mph
  $('#hudVehicle').textContent = s.inVehicle ? (s.vehicleDisplayName || 'Vehicle') : 'On foot';
  $('#hudWanted').textContent  = s.wantedLevel > 0 ? '★'.repeat(s.wantedLevel) : '—';
  $('#hudClock').textContent   =
    String(s.gameHour ?? 0).padStart(2, '0') + ':' + String(s.gameMinute ?? 0).padStart(2, '0');
  $('#hudPos').textContent     =
    `${s.x.toFixed(0)}, ${s.y.toFixed(0)}, ${(s.z ?? 0).toFixed(0)}`;
}

// --------------------------------------------------------------------------
// Calibration
// --------------------------------------------------------------------------
const calPoints = [
  { game: null, img: null },
  { game: null, img: null }
];
let pickingIndex = -1;

function calCapture(i) {
  if (!current) { toast('No position yet — start the feed first.'); return; }
  calPoints[i].game = { x: current.x, y: current.y };
  toast(`Point ${'AB'[i]} captured at ${current.x.toFixed(0)}, ${current.y.toFixed(0)}.`);
  renderCal();
}

function calArmPick(i) {
  if (!imageBounds) { toast('Load a map image first.'); return; }
  pickingIndex = pickingIndex === i ? -1 : i;
  document.body.classList.toggle('picking', pickingIndex >= 0);
  renderCal();
}

function onMapClick(e) {
  if (pickingIndex < 0) return;
  calPoints[pickingIndex].img = { lat: e.latlng.lat, lng: e.latlng.lng };
  pickingIndex = -1;
  document.body.classList.remove('picking');
  renderCal();
}

function renderCal() {
  calLayer.clearLayers();

  $$('.calpoint').forEach((row, i) => {
    const p = calPoints[i];
    const g = $('.cal-game', row), im = $('.cal-img', row);

    g.textContent = p.game ? `x ${p.game.x.toFixed(1)}  y ${p.game.y.toFixed(1)}` : '—';
    g.classList.toggle('set', !!p.game);

    // Report image pixels counting down from the top-left, which is what you
    // read off an image editor — not Leaflet's bottom-up lat.
    im.textContent = p.img
      ? `px ${p.img.lng.toFixed(0)}, ${((imageSize ? imageSize.h : 0) - p.img.lat).toFixed(0)}`
      : '—';
    im.classList.toggle('set', !!p.img);

    const pickBtn = $('.cal-pick', row);
    pickBtn.classList.toggle('armed', pickingIndex === i);
    pickBtn.textContent = pickingIndex === i ? 'Click the map…' : 'Pick on map';

    if (p.img) {
      L.marker([p.img.lat, p.img.lng], {
        interactive: false,
        icon: L.divIcon({ className: '', html: `<div class="cal-pin">${'AB'[i]}</div>` })
      }).addTo(calLayer);
    }
  });

  const ready = calPoints.every(p => p.game && p.img);
  $('#calApply').disabled = !ready;

  const t = settings.transform;
  $('#calSummary').textContent = t
    ? `Calibrated — ${t.a.toFixed(4)} px per game unit X, ${t.c.toFixed(4)} Y.`
    : 'Not calibrated. The marker stays hidden until you calibrate.';
}

// GTA V's map is roughly 8000 x 12000 world units across. Landmarks closer
// than this on either axis make that axis' scale hostage to a few pixels of
// click error, which throws the marker off across the rest of the map.
const MIN_CAL_SEPARATION = 500;

function calApply() {
  const dx = Math.abs(calPoints[1].game.x - calPoints[0].game.x);
  const dy = Math.abs(calPoints[1].game.y - calPoints[0].game.y);
  if (dx < MIN_CAL_SEPARATION || dy < MIN_CAL_SEPARATION) {
    const axis = dx < MIN_CAL_SEPARATION ? 'X (east/west)' : 'Y (north/south)';
    toast(`Those landmarks are only ${Math.round(Math.min(dx, dy))} units apart on ` +
          `${axis}. Pick a second one much further away — opposite corners of the ` +
          `map work best.`, 6000);
    return;
  }

  const t = solveTransform(calPoints[0], calPoints[1]);
  if (!t) { toast('Could not solve a transform from those points.'); return; }

  settings.transform = t;
  save();
  trailPts = [];
  redrawTrail();
  renderCal();

  // A north-up map image is scaled the same on both axes, so wildly different
  // scales (or a negative one) almost always means a mis-clicked point.
  const ratio = Math.abs(t.a) > Math.abs(t.c)
    ? Math.abs(t.a / t.c)
    : Math.abs(t.c / t.a);
  if (t.a < 0 || t.c < 0 || ratio > 1.25) {
    toast('Calibrated, but the X and Y scales disagree — that usually means a ' +
          'point was clicked in the wrong place. Check the marker, and redo it ' +
          'if it looks wrong.', 7000);
  } else {
    toast('Calibrated.');
  }
}

function calReset() {
  settings.transform = null;
  save();
  calPoints.forEach(p => { p.game = null; p.img = null; });
  pickingIndex = -1;
  document.body.classList.remove('picking');
  if (marker) { marker.remove(); marker = null; markerSvg = null; }
  trailPts = [];
  redrawTrail();
  renderCal();
  if (imageBounds) map.fitBounds(imageBounds);
  toast('Calibration cleared.');
}

// --------------------------------------------------------------------------
// UI wiring
// --------------------------------------------------------------------------
function setFollow(on) {
  settings.follow = on;
  $('#followToggle').checked = on;
  save();
}

function wireUi() {
  // Panel
  const panel = $('#panel');
  const open = settings.panelOpen === null ? window.innerWidth > 640 : settings.panelOpen;
  panel.classList.toggle('collapsed', !open);
  $('#panelToggle').setAttribute('aria-expanded', String(open));
  $('#panelToggle').addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    $('#panelToggle').setAttribute('aria-expanded', String(!collapsed));
    settings.panelOpen = !collapsed;
    save();
  });

  // Feed
  const mock = $('#mockToggle');
  mock.checked = settings.mock;
  mock.addEventListener('change', () => {
    settings.mock = mock.checked;
    save();
    startFeed();
  });

  const server = $('#serverInput');
  server.value = settings.server;
  server.addEventListener('change', () => {
    settings.server = server.value.trim();
    save();
    if (!settings.mock) startFeed();
  });

  // Calibration
  $$('.calpoint').forEach((row, i) => {
    $('.cal-capture', row).addEventListener('click', () => calCapture(i));
    $('.cal-pick', row).addEventListener('click', () => calArmPick(i));
  });
  $('#calApply').addEventListener('click', calApply);
  $('#calReset').addEventListener('click', calReset);

  // View
  const follow = $('#followToggle');
  follow.checked = settings.follow;
  follow.addEventListener('change', () => setFollow(follow.checked));

  const trail = $('#trailRange');
  trail.value = settings.trailLength;
  $('#trailOut').value = settings.trailLength;
  trail.addEventListener('input', () => {
    settings.trailLength = Number(trail.value);
    $('#trailOut').value = trail.value;
    save();
    while (trailPts.length > settings.trailLength) trailPts.shift();
    redrawTrail();
  });

  $('#trailClear').addEventListener('click', () => {
    trailPts = [];
    redrawTrail();
  });

  $('#recentre').addEventListener('click', () => {
    if (current && settings.transform) map.setView(gameToLatLng(current.x, current.y));
    else if (imageBounds) map.fitBounds(imageBounds);
  });

  // Map image
  $('#setupFile').addEventListener('change', e => pickImage(e.target.files[0]));
  $('#mapFile').addEventListener('change', e => pickImage(e.target.files[0]));

  // Escape cancels an armed pick
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && pickingIndex >= 0) {
      pickingIndex = -1;
      document.body.classList.remove('picking');
      renderCal();
    }
  });
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function init() {
  initMap();
  wireUi();
  renderCal();

  let saved = null;
  try {
    saved = await idbGet(DB_KEY);
  } catch (e) {
    console.warn('IndexedDB unavailable:', e);
  }

  if (saved && saved.blob) {
    try {
      await setMapImage(saved.blob, saved.name);
    } catch (e) {
      console.warn('Stored map image failed to load:', e);
      $('#setup').hidden = false;
    }
  } else {
    $('#setup').hidden = false;
  }

  startFeed();
  setInterval(updateHud, POLL_MS);
  requestAnimationFrame(frame);
}

init();

})();
