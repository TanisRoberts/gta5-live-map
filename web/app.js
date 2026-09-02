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
const RESTART_JUMP_MS = 1000; // a timestamp this far backwards = plugin restart
const STALE_MS       = 1500;  // no sample this long => feed considered dead
const FETCH_TIMEOUT  = 2000;
const TRAIL_MIN_MOVE = 3;     // game units between trail points

/*
 * A respawn teleports you across the map, and joining those two points draws a
 * line you never travelled. Anything further than this in one sample is taken
 * as a jump rather than movement.
 *
 * The budget is generous on purpose: a throttled background tab can leave a
 * second between samples, and a jet covers a lot of ground in a second. The
 * floor stops a stationary sample being called a teleport by rounding.
 */
const TRAIL_JUMP_FLOOR = 120;   // game units
const TRAIL_JUMP_FACTOR = 3;    // multiple of plausible travel in the gap
const TRAIL_EVENT_MAX = 40;     // markers kept before the oldest is dropped

/*
 * Plate designs, keyed by the game's own LicensePlateStyle.
 *
 * The six base styles are grounded rather than guessed: vehshare.ytd holds
 * exactly plate01..plate05 plus yankton_plate, matching the six base enum
 * values, and Rockstar named five of them after their own colours. San Andreas
 * is the state (Los Santos is a city in it), which is why the banner reads the
 * way a California plate does.
 *
 * The Enhanced-only branded styles below are a reasonable reading of each
 * brand, NOT checked against the artwork — their textures live in DLC archives
 * that have not been opened. The banner text is right; treat the colours as
 * provisional.
 */
const PLATE_STYLES = {
  BlueOnWhite1:  { bg: '#fefdf6', edge: '#a9a68f', ink: '#17307d', band: '#33599f', text: 'San Andreas' },
  BlueOnWhite2:  { bg: '#fefdf6', edge: '#a9a68f', ink: '#17307d', band: '#33599f', text: 'San Andreas' },
  BlueOnWhite3:  { bg: '#fefdf6', edge: '#a9a68f', ink: '#17307d', band: '#33599f', text: 'San Andreas' },
  YellowOnBlue:  { bg: '#1b3f8f', edge: '#0f2557', ink: '#ffd23f', band: '#ffd23f', text: 'San Andreas' },
  YellowOnBlack: { bg: '#141414', edge: '#000000', ink: '#f5c518', band: '#f5c518', text: 'San Andreas' },
  NorthYankton:  { bg: '#f2f6fb', edge: '#9fb0c4', ink: '#1d4c86', band: '#1d4c86', text: 'North Yankton' },
  // Provisional, as noted above.
  ECola:         { bg: '#f4f2ea', edge: '#a33', ink: '#c0242c', band: '#c0242c', text: 'eCola' },
  Sprunk:        { bg: '#f4f2ea', edge: '#3a7d2c', ink: '#2f7a24', band: '#2f7a24', text: 'Sprunk' },
  LasVenturas:   { bg: '#fdf6e6', edge: '#b09a63', ink: '#8a1f1f', band: '#8a1f1f', text: 'Las Venturas' },
  LibertyCity:   { bg: '#f7f7f2', edge: '#9a9a8c', ink: '#294a2e', band: '#294a2e', text: 'Liberty City' },
  LSCarMeet:     { bg: '#17181c', edge: '#000000', ink: '#e8e6df', band: '#7ad0ff', text: 'LS Car Meet' },
  LSPanic:       { bg: '#17181c', edge: '#000000', ink: '#e8e6df', band: '#ff7ac0', text: 'Los Santos' },
  LSPounders:    { bg: '#f4f2ea', edge: '#a9a68f', ink: '#7a3410', band: '#c25f1c', text: 'Los Santos' }
};
const PLATE_DEFAULT = PLATE_STYLES.BlueOnWhite1;

/*
 * Separate follow zooms for driving and walking. On foot you want to see the
 * street you are on; at speed you want to see what is coming. Switching mode
 * snaps to the relevant one, which also discards any manual zoom — that is
 * deliberate, so the two levels stay predictable.
 */
const ZOOM_VEHICLE = 0.5;
const ZOOM_FOOT    = 2;

// Where the tacho's red zone starts. The game exposes no redline of its own,
// so this is our choice, not a value read from the vehicle.
const RPM_REDLINE = 0.85;

// Engine condition. The game's scale runs 1000 down to 0, and on past it into
// negatives once the engine is dead; the plugin sends it raw so these stay
// tunable here.
const ENGINE_MAX  = 1000;
const ENGINE_HURT = 700;   // below this it is visibly smoking
const ENGINE_DEAD = 0;     // at or below, it will not run

/*
 * The game's own day/night boundaries, not guessed ones.
 *
 * GTA V's timecycle files (common/data/timecycle/w_*.xml, read out of the
 * archives with the tile ripper's --dump) hold 13 keyframes per property, on
 * the engine's fixed hours 0, 5, 6, 7, 10, 12, 16, 17, 19, 20,
 * 21, 22, 24. Keyframe 5 is noon, which is where light_dir_mult peaks at 64 --
 * that is the check that the mapping is right rather than assumed.
 *
 * In w_extrasunny.xml the sun term light_dir_mult reads:
 *   0.2  0.0  5.0  10.0  32.0  64.0  52.0  40.0  22.0  12.0  5.0  0.0  0.2
 * It is exactly zero at 05:00 and 22:00 and non-zero between, so the sun
 * contributes nothing outside 06:00-21:00. The hours either side are the
 * interpolated dawn and dusk.
 */
const DAWN_START  = 5;
const DAY_START   = 6;
const DUSK_START  = 21;
const NIGHT_START = 22;

/*
 * Trail styling.
 *
 * The old 2.5px translucent blue was picked against the near-black raster map.
 * The vector map is far lighter — pale roads, tan coastline — and that blue
 * nearly vanished on it.
 *
 * Each segment is drawn twice: a dark casing underneath, then the colour on
 * top. That is the standard cartographic trick for a line that has to stay
 * legible over both pale roads and near-black terrain, and it costs one extra
 * polyline per segment.
 *
 * Weight is deliberately well under the player arrow (~20px of visible width
 * at a 30px icon). The trail should read as bold, not compete with the marker.
 */
const TRAIL_WEIGHT = 7;
const TRAIL_CASING_EXTRA = 4;

/*
 * SHVDN reports 23 vehicle classes; that is far more detail than is useful at a
 * glance, so they collapse to a handful of categories. Done here rather than in
 * the plugin so the grouping can be retuned without a rebuild and a reload.
 *
 * Hues are spread widely and kept saturated, because the map itself is almost
 * entirely desaturated greys and tans — anything muted disappears into it.
 */
/*
 * Hues chosen to sit apart from each other, not just to look nice. The
 * closest pair is red and yellow at 35 degrees, which the eye separates
 * easily; everything else is 44 degrees or more.
 *
 * Three of them land near a character colour — green near Franklin, blue near
 * Michael, yellow near Trevor, all within about 12 degrees. That is tolerable
 * because the trail is fully saturated where the HUD colours are not, and
 * because the player arrow carries a white glow that separates it from any
 * line it happens to be sitting on.
 */
const TRAIL_COLOURS = {
  car:   '#ffd23f',   // yellow
  foot:  '#3ddc5a',   // green
  boat:  '#2f9dff',   // blue
  air:   '#b57bff',   // purple
  bike:  '#ff2a2a',   // red
  other: '#ff4de0'    // magenta
};

const TRAIL_LABELS = {
  foot: 'On foot', car: 'Car', bike: 'Bike',
  boat: 'Boat', air: 'Aircraft', other: 'Other'
};

/** Exact VehicleClass names, read off the assembly rather than guessed. */
const VEHICLE_CATEGORY = {
  Compacts: 'car', Sedans: 'car', SUVs: 'car', Coupes: 'car', Muscle: 'car',
  SportsClassics: 'car', Sports: 'car', Super: 'car', OffRoad: 'car',
  Industrial: 'car', Utility: 'car', Vans: 'car', Service: 'car',
  Emergency: 'car', Military: 'car', Commercial: 'car', OpenWheel: 'car',
  Motorcycles: 'bike', Cycles: 'bike',
  Boats: 'boat',
  Helicopters: 'air', Planes: 'air',
  Trains: 'other'
};
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
  trailVisible: true,
  mock:        false,
  server:      "",
  // Persisted now that the settings panel can actually change them. They were
  // briefly constants precisely because it could not.
  autoZoom:    true,
  zoomVehicle: ZOOM_VEHICLE,
  zoomFoot:    ZOOM_FOOT,
  units:       'mph',    // 'mph' | 'kmh'
  vignette:    true,
  uiHidden:    false,
  transformSource: null  // "auto" (from the setup tool) or "manual"
};

/*
 * GTA's vehicle colours are enum names, not values. This maps the families to
 * something close enough for a 10px swatch — the point is "roughly that colour
 * at a glance", not a paint match. Anything unrecognised falls back to grey
 * rather than guessing wrong.
 */
const COLOUR_SWATCH = [
  [/black|carbon/i,          '#15181c'],
  [/white|ice/i,             '#e8ebee'],
  [/silver|chrome|platinum/i,'#b9c0c7'],
  [/(^|[^a-z])grey|gray|gunmetal|anthracite|graphite/i, '#6b7480'],
  [/red|crimson|garnet|wine|cherry/i, '#c0392b'],
  [/orange|copper|bronze|sunset/i,    '#d3641d'],
  [/yellow|gold|lime.?green|bright.?yellow/i, '#d8b021'],
  [/green|olive|forest|moss/i,        '#2e7d46'],
  [/aqua|teal|turquoise/i,            '#1f8f92'],
  [/blue|navy|ultra.?blue|midnight/i, '#2b6cb0'],
  [/purple|violet|lilac|indigo/i,     '#6b4b9c'],
  [/pink|magenta|salmon/i,            '#c2568c'],
  [/brown|beige|tan|cream|sand|umber/i, '#8a7355']
];

function colourSwatch(name) {
  if (!name) return null;
  if (/^custom$/i.test(name)) return null;
  for (const [re, hex] of COLOUR_SWATCH) if (re.test(name)) return hex;
  return '#6b7480';
}

/** "MetallicBlack" -> "Metallic Black" */
function prettyColour(name) {
  if (!name) return '';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

let settings = load();

function load() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const s = Object.assign({}, defaults, saved);
  // A half-written or hand-edited transform would otherwise produce NaN
  // coordinates and a map that is silently, inexplicably dead.
  if (!isValidTransform(s.transform)) s.transform = null;
  return s;
}

function isValidTransform(t) {
  return !!t && ['a', 'b', 'c', 'd'].every(k => Number.isFinite(t[k])) && t.a !== 0 && t.c !== 0;
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

/* True while the last raw sample had the player dead or under arrest. Declared
   here with the rest of the feed state because resetBuffer clears it, and that
   runs before anything further down the file has been evaluated. */
let wasDown = false;

/* So one break is applied once, not once per frame while its sample is current. */
let lastBreakT = null;
let lastGoodAt  = -Infinity;

/*
 * Observed gap between samples, as an EMA. This is NOT always the poll interval:
 * browsers clamp timers to roughly 1 Hz in a hidden tab, which happens whenever
 * the game is fullscreen over the top of the browser. Rather than declare the
 * feed dead or stutter the marker, the render delay and the staleness threshold
 * both scale off whatever rate we are actually managing.
 */
let sampleGapMs = POLL_MS;

/** How far behind live to draw, so we interpolate rather than extrapolate. */
function renderDelayMs() {
  return Math.max(RENDER_DELAY_MS, sampleGapMs * 1.6);
}

/** Silence for longer than this means the feed really has stopped. */
function staleMs() {
  return Math.max(STALE_MS, sampleGapMs * 3);
}

function pushSample(s) {
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.t)) return;

  // The producer's clock is monotonic since IT started, not since we did. A
  // timestamp that jumps backwards means the plugin was reloaded (which happens
  // constantly while developing it), so drop the old history and resync rather
  // than rejecting every sample from the new run as stale forever.
  if (s.t < lastSampleT - RESTART_JUMP_MS) {
    resetBuffer();
  } else if (s.t <= lastSampleT) {
    return;                                         // dedupe / out-of-order
  }
  lastSampleT = s.t;

  const now = performance.now();
  const off = now - s.t;
  if (clockOffset === null || off < clockOffset) clockOffset = off;
  else clockOffset += (off - clockOffset) * 0.002;

  s.lt = s.t + clockOffset;

  const prev = buf[buf.length - 1];
  if (prev) {
    const gap = s.lt - prev.lt;
    // Ignore absurd gaps (tab suspended, game paused) so one outlier does not
    // drag the estimate up for minutes afterwards.
    if (gap > 0 && gap < 5000) sampleGapMs += (gap - sampleGapMs) * 0.2;
  }

  // Classified here, on raw samples, before interpolation can smooth it away.
  s.trail = classifySample(s, prev);

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
  sampleGapMs = POLL_MS;
  wasDown = false;
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

  /*
   * Never interpolate across a classified sample. Blending a pre-death
   * position with a post-respawn one produces a smooth walk across the map
   * that is not where anybody was, and that blend is what hid the teleport in
   * the first place. Snap to the newer sample instead.
   */
  if (q.trail) return q;

  const span = q.lt - p.lt;
  const u = span > 0 ? (tLocal - p.lt) / span : 0;

  // Start from the newer sample so every field carries through, then override
  // only the ones that are meaningful to interpolate.
  //
  // This used to enumerate fields by hand, which meant each new field added to
  // the plugin silently vanished here until someone remembered to list it —
  // vehicleClass did exactly that, so the trail fell back to "car" for
  // everything. Spreading is the version that cannot rot.
  return Object.assign({}, q, {
    x: lerp(p.x, q.x, u),
    y: lerp(p.y, q.y, u),
    z: lerp(p.z, q.z, u),
    heading: lerpAngle(p.heading, q.heading, u),
    speed:   lerp(p.speed, q.speed, u)
  });
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

/** Last time /pos answered at all, regardless of whether the sample was new. */
let lastHttpOkAt = -Infinity;

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
    // Note the HTTP success separately from the sample. If the server keeps
    // answering but the timestamp stops advancing, the game is paused rather
    // than unreachable — a very different thing to tell the user.
    lastHttpOkAt = performance.now();
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
/*
 * The mock exists so the whole UI can be exercised with the game shut, which
 * only works if it produces the same SHAPE the plugin does. It had drifted —
 * sending no vehicleClass at all, so every mock vehicle fell back to "car" and
 * the trail could never change colour. These entries deliberately cover every
 * trail category, and carry the colour/plate/street fields the cards will need.
 */
const MOCK_VEHICLES = [
  { name: 'Sultan',      make: 'Karin',       cls: 'Sports',      colour: 'MetallicBlue',  plate: '46EEK572', wheels: 4 },
  { name: 'Buffalo STX', make: 'Bravado',     cls: 'Sedans',      colour: 'MetallicBlack', plate: '11ABC222', wheels: 4 },
  null,                                                                                    // on foot
  { name: 'Sanchez',     make: 'Maibatsu',    cls: 'Motorcycles', colour: 'MatteRed',      plate: '99XYZ001', wheels: 2 },
  { name: 'Dinghy',      make: 'Speedophile', cls: 'Boats',       colour: 'MetallicWhite', plate: null,       wheels: 0 },
  { name: 'Buzzard',     make: 'Nagasaki',    cls: 'Helicopters', colour: 'MetallicGreen', plate: null,       wheels: 0 },
  null
];

const MOCK_STREETS = [
  { street: 'Vinewood Blvd',   crossing: 'Mad Wayne Thunder Dr', zone: 'Vinewood' },
  { street: 'Del Perro Fwy',   crossing: null,                   zone: 'Del Perro' },
  { street: "Adam's Apple Blvd", crossing: 'Power St',           zone: 'Pillbox Hill' },
  { street: 'Great Ocean Hwy', crossing: null,                   zone: 'Chumash' }
];

const MOCK_PHASE_MS = 30000;

let mockTimer   = null;
let mockPrev    = null;
let mockTheta   = 0;
let mockHeading = 0;
let mockWasDead = false;
const MOCK_DEATH_PERIOD_MS = 45000;   // how often the mock dies

/*
 * HUD colours as GET_HUD_COLOUR actually reports them, so the mock agrees with
 * the plugin. Michael and Franklin are observed from the live feed; Trevor has
 * not been seen yet and is the one value here still to be confirmed.
 *
 * Guessing these was already wrong once: Michael was assumed to be a pale
 * #9bc3e8 and is really a much stronger #65b4d4.
 */
const MOCK_CHARACTERS = [
  { name: "Michael",  colour: "#65b4d4" },
  { name: "Franklin", colour: "#abedab" },
  { name: "Trevor",   colour: "#f0b48f" }   // unconfirmed
];

function mockPos(theta) {
  const R = 1400 * (1 + 0.12 * Math.sin(3 * theta));
  return { x: 200 + R * Math.cos(theta), y: 200 + R * Math.sin(theta), R };
}

function mockTick() {
  const t = performance.now();
  const dt = mockPrev ? Math.min((t - mockPrev.t) / 1000, 0.25) : 0;

  /*
   * Die periodically, so the trail's break and its death marker can be tested
   * without repeatedly getting killed in game. Dead is flagged for a moment at
   * the spot, then the position jumps the way a hospital respawn does; every
   * other cycle is an arrest instead, so both markers get exercised.
   */
  const inCycle = t % MOCK_DEATH_PERIOD_MS;
  const dead = inCycle < 800;
  const arrestTurn = Math.floor(t / MOCK_DEATH_PERIOD_MS) % 2 === 1;
  if (!dead && mockWasDead) {
    mockTheta += 2.1;        // the teleport
    mockPrev = null;         // or the jump reads as an impossible speed
  }
  mockWasDead = dead;

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

  const place = MOCK_STREETS[Math.floor(t / 20000) % MOCK_STREETS.length];

  // Gear and revs, derived from speed so the tacho sweeps and resets the way a
  // cluster does, crossing the red zone just before each change. Kept in the
  // mock because a mock that has drifted from the plugin's shape hides bugs:
  // this one previously sent no vehicleClass, so every mock vehicle read as a
  // car and a broken trail-colour path looked fine.
  const MOCK_TOP_SPEED = 40;   // m/s at which top gear is reached
  const MOCK_GEARS = 6;
  let gear = 0, rpm = 0;
  if (veh) {
    const f = Math.min(speed / MOCK_TOP_SPEED, 0.999);
    gear = Math.floor(f * MOCK_GEARS) + 1;
    rpm = 0.2 + 0.75 * ((f * MOCK_GEARS) % 1);
  }

  pushSample({
    x: p.x,
    y: p.y,
    z: 30 + 25 * Math.sin(mockTheta * 2),
    heading: mockHeading,
    speed,
    rpm,
    gear,
    fuel: veh ? 65 : -1,
    inVehicle: !!veh,
    vehicleDisplayName: veh ? veh.name : null,
    vehicleClass:       veh ? veh.cls : null,
    vehicleColor:       veh ? veh.colour : null,
    licensePlate:       veh ? veh.plate : null,
    // Walk every plate design in turn, so all thirteen can be looked at
    // without owning thirteen cars.
    plateStyle:         veh ? Object.keys(PLATE_STYLES)[Math.floor(t / 4000) % Object.keys(PLATE_STYLES).length] : null,
    vehicleMake:        veh ? veh.make : null,
    /*
     * Damage cycles so every tell-tale state can be seen with the game shut:
     * the engine walks healthy -> damaged -> destroyed, and tyres go flat one
     * at a time. A mock that only ever shows the happy path proves nothing.
     */
    engineHealth:       veh ? [1000, 1000, 450, 0][Math.floor(t / 9000) % 4] : 0,
    onFire:             false,
    tyresBurst:         veh ? Math.min(veh.wheels, Math.floor(t / 13000) % 3) : 0,
    tyreCount:          veh ? veh.wheels : 0,
    // Engine and lights cycle so the tell-tales can be seen changing with the
    // game shut, rather than sitting in one state forever.
    engineRunning:      !!veh,
    lightsOn:           !!veh && Math.floor(t / 7000) % 3 > 0,
    highBeams:          !!veh && Math.floor(t / 7000) % 3 === 2,
    // Cycles into the broken state so the red lights tell-tale can be seen
    // without shooting a car's headlights out.
    headlightsGone:     !!veh && Math.floor(t / 11000) % 4 === 3,
    headlightL:         !!veh && Math.floor(t / 11000) % 4 >= 2,
    headlightR:         !!veh && Math.floor(t / 11000) % 4 === 3,
    streetName:     place.street,
    crossingStreet: place.crossing,
    zoneName:       place.zone,
    // Cycles the three protagonists, with the game's own HUD colours, so the
    // avatar can be exercised without switching character in game.
    character:      MOCK_CHARACTERS[Math.floor(t / 15000) % MOCK_CHARACTERS.length].name,
    characterColor: MOCK_CHARACTERS[Math.floor(t / 15000) % MOCK_CHARACTERS.length].colour,
    wantedLevel: Math.floor(t / 25000) % 6,
    isDead:     dead && !arrestTurn,
    isArrested: dead && arrestTurn,
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
  /*
   * Only judge staleness when someone is actually looking.
   *
   * A hidden tab has its timers throttled — to once a second, and to once a
   * minute after a while — so the feed goes stale because WE stopped asking,
   * not because the plugin stopped answering. Reporting signal loss for that
   * is crying wolf, and an indicator whose entire value is being trusted
   * cannot afford it. The brief settling window covers the gap between
   * becoming visible and the first poll landing.
   */
  const now = performance.now();
  const settling = document.hidden || (now - becameVisibleAt < 1200);
  const fresh = settling || (now - lastGoodAt < staleMs());

  /*
   * A paused game still answers /pos — the HTTP thread is untouched — but the
   * script stops ticking, so the timestamp freezes and no new samples arrive.
   * That is a completely different situation from the plugin being gone, and
   * calling both "No signal" sent us chasing a phantom once already.
   */
  const paused = !fresh && !settings.mock && (now - lastHttpOkAt < 3000);

  // The always-visible light. A frozen marker with no explanation reads as a
  // paused game rather than a broken feed, so this must not live behind the
  // settings cog.
  const signal = $('#signal'), signalText = $('#signalText');
  signal.classList.toggle('lost', !fresh && !paused);
  signal.classList.toggle('paused', paused);
  signalText.textContent = settings.mock ? 'Mock'
    : fresh  ? 'Live'
    : paused ? 'Paused'
    : 'No signal';
  /*
   * Dim every data card on signal loss, and only on signal loss.
   *
   * The street name is a claim about right now, and so are the speed, the
   * revs and the vehicle — a confident-looking card over a dead feed is a
   * lie. Previously only the nav card dimmed, which read as a rendering
   * glitch rather than a signal, because nothing around it agreed.
   *
   * A paused game is excluded on purpose: that data is stopped, not wrong,
   * and the amber Paused light already says so.
   */
  const lost = !fresh && !paused;
  $('#navCard').classList.toggle('stale', lost);
  $('#vehicleCard').classList.toggle('stale', lost);
  $('#speedo').classList.toggle('stale', lost);

  // Detail, for the Advanced section.
  const dot = $('#feedDot'), txt = $('#feedStatus');
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

/**
 * CRS whose projected pixels run from the image's TOP-left, rather than
 * CRS.Simple's default of counting upward from zero.
 *
 * Latitude/longitude are unaffected — this only changes how Leaflet projects
 * them to screen — so the calibration transform is valid either way. It matters
 * for tiles: with the default transformation the projected Y is negative, so
 * Leaflet asks for negative tile rows. Shifting by the image height makes row 0
 * the top of the map, which is how the pyramid is written.
 *
 * This has to be decided when the map is CREATED. Assigning map.options.crs
 * later leaves Leaflet's cached pixel origin describing the old projection, and
 * the symptom is a tile layer that quietly renders nothing at all.
 */
function topLeftCrs(height) {
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(1, 0, -1, height)
  });
}
let marker = null, markerSvg = null;
let trailLayer = null;
let trailPts = [];          // game-space points, each tagged with its category
let eventLayer = null;      // death and arrest markers
let trailEvents = [];       // {x, y, kind} for those markers
let calLayer = null;

function initMap(tileHeight) {
  map = L.map('map', {
    // Tiles need the top-left projection; a plain image overlay does not care.
    crs: tileHeight ? topLeftCrs(tileHeight) : L.CRS.Simple,
    minZoom: -8,
    maxZoom: 6,
    zoomControl: true,
    attributionControl: false,
    zoomSnap: 0.25,
    preferCanvas: true
  });
  map.setView([0, 0], 0);

  calLayer  = L.layerGroup().addTo(map);
  // A group rather than one polyline: the trail is drawn as a run of segments
  // so it can change colour wherever the vehicle type changes.
  trailLayer = L.layerGroup().addTo(map);
  // Above the trail, so a marker is never hidden under the line it interrupts.
  eventLayer = L.layerGroup().addTo(map);

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

let overlayUrl = null;

/**
 * Uses the tile pyramid the setup tool built, rather than one enormous image.
 *
 * An 8192-wide map is a 19 MB PNG but roughly 400 MB of RGBA once decoded, and
 * an imageOverlay holds all of it at every zoom. Tiles are fetched only where
 * you are looking.
 *
 * Latitude/longitude stay in full-resolution pixels, so Leaflet zoom 0 is the
 * sharpest level and the lower levels are negative. tileLayer's zoomOffset maps
 * those back onto the folder names 0..maxZoom on disk.
 */
function setMapTiles(base, manifest) {
  const t = manifest.tiles;
  const w = manifest.width, h = manifest.height;

  imageBounds = L.latLngBounds([[0, 0], [h, w]]);
  imageSize = { w: w, h: h };

  if (overlay) overlay.remove();
  if (overlayUrl) { URL.revokeObjectURL(overlayUrl); overlayUrl = null; }

  overlay = L.tileLayer(base + '/map/' + t.path, {
    tileSize: t.tileSize,
    // minZoom/maxZoom are the LAYER's own limits and both must be set. Leaflet
    // discards the tile zoom entirely when it falls outside them, and the
    // layer's default minZoom is 0 — so with only minNativeZoom set, every
    // negative zoom renders nothing at all, silently.
    minZoom: -t.maxZoom,
    maxZoom: 3,
    // Native levels run -maxZoom..0; allowing a little beyond lets Leaflet
    // scale the sharpest tiles up rather than refusing to zoom further.
    minNativeZoom: -t.maxZoom,
    maxNativeZoom: 0,
    zoomOffset: t.maxZoom,
    bounds: imageBounds,
    noWrap: true,
    keepBuffer: 2
  }).addTo(map);
  overlay.bringToBack();

  map.setMinZoom(-t.maxZoom);
  map.setMaxZoom(3);
  map.setMaxBounds(imageBounds.pad(0.6));
  awaitingFirstFix = true;
  map.fitBounds(imageBounds);

  $('#imgInfo').textContent =
    `${w} × ${h} px, ${t.count} tiles (zoom 0–${t.maxZoom})`;
}

async function setMapImage(blob, name) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload  = res;
      img.onerror = () => rej(new Error('That file could not be decoded as an image.'));
      img.src = url;
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }

  const w = img.naturalWidth, h = img.naturalHeight;
  imageBounds = L.latLngBounds([[0, 0], [h, w]]);
  imageSize   = { w, h };

  if (overlay) overlay.remove();
  if (overlayUrl) URL.revokeObjectURL(overlayUrl);   // don't leak the old image
  overlayUrl = url;
  overlay = L.imageOverlay(url, imageBounds).addTo(map);
  overlay.bringToBack();

  map.setMaxBounds(imageBounds.pad(0.6));
  map.setMinZoom(map.getBoundsZoom(imageBounds) - 3);
  awaitingFirstFix = true;
  map.fitBounds(imageBounds);

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

/** Which trail colour a sample belongs to. */
function trailCategory(s) {
  if (!s || !s.inVehicle) return 'foot';
  return VEHICLE_CATEGORY[s.vehicleClass] || 'car';
}

/**
 * Rebuilds the trail as one polyline pair per run of consecutive points that
 * share a category. Each run reaches one point into the next so the colours
 * butt up against each other instead of leaving a gap at every change.
 */
function redrawTrail() {
  trailLayer.clearLayers();
  // Hidden is a display choice, not a reason to stop recording — the points
  // keep accumulating so turning it back on shows where you actually went.
  if (!settings.trailVisible) return;
  if (!settings.transform || trailPts.length < 2) return;

  let start = 0;
  for (let i = 1; i <= trailPts.length; i++) {
    const ended = i === trailPts.length;
    // A break marks a place we did not travel — a respawn, or a mission warp.
    // It ends the run just like a colour change, but differently: a colour
    // change is continuous, so its run reaches one point into the next to butt
    // the colours together, whereas a break must stop short or we would draw
    // the very line we are trying to avoid.
    const broken = !ended && trailPts[i].brk;
    if (!ended && !broken && trailPts[i].cat === trailPts[start].cat) continue;

    const run = trailPts.slice(start, (ended || broken) ? i : i + 1);
    if (run.length >= 2) {
      const pts = run.map(p => gameToLatLng(p.x, p.y));
      const colour = TRAIL_COLOURS[trailPts[start].cat] || TRAIL_COLOURS.other;

      // Dark casing first, so the colour stays readable over pale roads and
      // near-black terrain alike.
      L.polyline(pts, {
        color: '#0b0e12', weight: TRAIL_WEIGHT + TRAIL_CASING_EXTRA,
        opacity: 0.55, lineCap: 'round', lineJoin: 'round', interactive: false
      }).addTo(trailLayer);

      L.polyline(pts, {
        color: colour, weight: TRAIL_WEIGHT,
        opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false
      }).addTo(trailLayer);
    }

    start = i;
  }
}

function pushTrail(x, y, cat, brk) {
  const n = settings.trailLength;
  if (n <= 0) {
    if (trailPts.length) { trailPts = []; trailLayer.clearLayers(); }
    if (trailEvents.length) { trailEvents = []; drawEvents(); }
    return;
  }

  const last = trailPts[trailPts.length - 1];
  // Always record a point when the category changes, however small the move,
  // or the colour boundary lands wherever the next 3-unit step happens to fall.
  // A break must always be recorded, however small the step, or the trail
  // would rejoin across the very gap it marks.
  if (!brk && last && last.cat === cat && Math.hypot(x - last.x, y - last.y) < TRAIL_MIN_MOVE) return;

  trailPts.push({ x, y, cat, brk: !!brk });
  while (trailPts.length > n) trailPts.shift();
  redrawTrail();
}

let current = null;   // most recent interpolated state, for the HUD

/*
 * Set whenever the base layer is (re)created. Fitting the whole island is the
 * right thing to show before any position is known, but it is the wrong zoom to
 * then sit at — follow mode preserves the current zoom, so without this a
 * reload silently dropped you from street level to the whole map.
 */
let awaitingFirstFix = true;

/** null until the first fix, so the first sample does not count as a change. */
let lastInVehicle = null;

/** When the tab last became visible — see updateFeedStatus. */
let becameVisibleAt = 0;

/**
 * Advances the interpolated state.
 *
 * Deliberately NOT tied to the animation frame. Browsers pause
 * requestAnimationFrame outright in a hidden tab — not throttled like
 * setInterval, stopped — which happens whenever the game covers the browser.
 * With everything hanging off rAF the status line read "Live" while the HUD
 * stayed blank and no marker ever appeared, which is worse than saying nothing.
 * The HUD timer calls this too, so the readout is correct the moment you look.
 */

/**
 * Whether a freshly arrived raw sample should be recorded, skipped, or begin a
 * new run. Returns 'skip', 'break', or '' for ordinary travel.
 *
 * Death and arrest are driven by the game's own flags rather than inferred
 * from the size of the position jump. Inferring it did not work: time stops
 * during the wasted sequence, so the feed goes quiet and then delivers one
 * sample far away, and sampleAt walked between the two over many frames —
 * dozens of small steps, none of them impossible, drawing the very line across
 * the map the check existed to catch.
 *
 * The flags have neither problem. The marker lands on the first sample that
 * reports you down, which is exactly where it happened, and nothing about it
 * depends on how far the respawn moved you or how long the feed was quiet.
 *
 * This must run on RAW samples, before any interpolation.
 */
function classifySample(s, prev) {
  const dead = !!s.isDead;
  const down = dead || !!s.isArrested;

  // Rising edge: where the journey actually ended.
  if (down && !wasDown) {
    trailEvents.push({ x: s.x, y: s.y, kind: dead ? 'death' : 'arrest' });
    while (trailEvents.length > TRAIL_EVENT_MAX) trailEvents.shift();
    drawEvents();
  }
  const revived = !down && wasDown;
  wasDown = down;

  // Record nothing while you are down. A body does not travel, and whatever
  // the camera does over the wasted sequence is not a journey.
  if (down) return 'skip';

  // First sample back on your feet: start a new run rather than joining it to
  // where you fell.
  if (revived) return 'break';

  /*
   * Everything else that moves impossibly far is a mission warp or a fast
   * travel. Break for those too — we still did not drive them — but do not
   * invent a death to explain them.
   */
  if (!prev) return '';
  const gapSec = Math.max(0, (s.t - prev.t) / 1000);
  const moved = Math.hypot(s.x - prev.x, s.y - prev.y);
  const plausible = Math.max(TRAIL_JUMP_FLOOR,
                             (Math.abs(s.speed || 0) + 10) * gapSec * TRAIL_JUMP_FACTOR);
  return moved > plausible ? 'break' : '';
}

/** Death and arrest markers, redrawn whole — there are only ever a handful. */
function drawEvents() {
  if (!eventLayer) return;
  eventLayer.clearLayers();
  // Tied to the trail's own visibility: these mark breaks in it, and a marker
  // floating over a hidden trail explains nothing.
  if (!settings.trailVisible || !settings.transform) return;

  trailEvents.forEach(e => {
    L.marker(gameToLatLng(e.x, e.y), {
      interactive: false,
      keyboard: false,
      zIndexOffset: 500,
      icon: L.divIcon({
        className: '',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        html: '<div class="trail-event ' + e.kind + '">' +
              '<svg viewBox="0 0 24 24"><use href="#i-' + e.kind + '"/></svg></div>'
      })
    }).addTo(eventLayer);
  });
}

function sampleCurrent() {
  const s = sampleAt(performance.now() - renderDelayMs());
  if (!s) return null;

  current = s;

  // Record the trail here rather than in the render loop. The trail is a
  // record of where you went, not a drawing artefact — tying it to
  // requestAnimationFrame meant a hidden tab silently lost the whole route,
  // which is the opposite of what a breadcrumb trail is for.
  /*
   * Nothing is recorded while you are down, so the trail simply stops where
   * you fell and picks up again where you came back.
   *
   * The break belongs to one sample, but that sample stays current for many
   * frames while the render delay catches up, so it is applied once — or every
   * frame would push another break point at the same spot.
   */
  if (s.trail !== 'skip') {
    const brk = s.trail === 'break' && s.t !== lastBreakT;
    if (brk) lastBreakT = s.t;
    pushTrail(s.x, s.y, trailCategory(s), brk);
  }

  return s;
}

function frame() {
  requestAnimationFrame(frame);
  const s = sampleCurrent();
  if (!s) return;

  const ll = gameToLatLng(s.x, s.y);
  if (!ll) return;

  ensureMarker();
  marker.setLatLng(ll);

  if (!markerSvg && marker.getElement()) markerSvg = marker.getElement().querySelector('svg');
  if (markerSvg) markerSvg.style.transform = `rotate(${headingToCssDeg(s.heading).toFixed(1)}deg)`;

  // Getting in or out of a vehicle changes what you need to see: the street
  // you are standing on, or what is coming at 80mph. Snapping to the relevant
  // zoom also discards any manual zoom, which is intended — the two levels stay
  // predictable rather than drifting with whatever you last scrolled to.
  const inVehicle = !!s.inVehicle;
  const modeChanged =
    settings.autoZoom && lastInVehicle !== null && lastInVehicle !== inVehicle;
  lastInVehicle = inVehicle;

  if (settings.follow) {
    if (awaitingFirstFix || modeChanged) {
      awaitingFirstFix = false;
      map.setView(ll, modeZoom(inVehicle), { animate: modeChanged });
    } else {
      // Otherwise leave the zoom alone, so scrolling still works.
      map.setView(ll, map.getZoom(), { animate: false });
    }
  }
}

/**
 * Follow zoom for the current mode. Now backed by settings, since the panel can
 * change them — the constants remain the fallback for a corrupt stored value.
 */
function modeZoom(inVehicle) {
  const z = inVehicle ? settings.zoomVehicle : settings.zoomFoot;
  return Number.isFinite(z) ? z : (inVehicle ? ZOOM_VEHICLE : ZOOM_FOOT);
}

/**
 * The in-game clock, and which part of the day it belongs to. Hours come from
 * the game's own timecycle keyframes — see DAY_START above.
 */
function updateClock(s) {
  const el = $('#clock');
  const h = s.gameHour, m = s.gameMinute;
  if (!Number.isFinite(h) || !Number.isFinite(m)) { el.hidden = true; return; }
  el.hidden = false;

  $('#clockTime').textContent =
    String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

  const phase = h >= NIGHT_START || h < DAWN_START ? 'night'
              : h < DAY_START                      ? 'dawn'
              : h < DUSK_START                     ? 'day'
              : 'dusk';
  el.classList.remove('day', 'night', 'dawn', 'dusk');
  el.classList.add(phase);

  // Moon only in true night; dawn and dusk keep the sun, tinted, because the
  // sun is still contributing light in those hours.
  $('#clockIcon').firstElementChild.setAttribute(
    'href', phase === 'night' ? '#i-moon' : '#i-sun');
  el.title = 'In-game time — ' + phase;
}

/*
 * Light one tell-tale. The class carries the colour (see .status-row in the
 * stylesheet); the label carries the same state as text, since a colour change
 * on its own says nothing to a screen reader.
 */
function setTellTale(el, state, label) {
  el.classList.remove('on', 'beam', 'warn', 'caution');
  if (state) el.classList.add(state);
  el.setAttribute('aria-label', label);
}

function updateHud() {
  updateFeedStatus();
  // rAF is paused while the tab is hidden, so advance the state here too.
  const s = sampleCurrent();
  if (!s) return;

  // The clock applies on foot as much as in a vehicle, so it sits above the
  // guard below rather than inside it.
  updateClock(s);
  updateAvatar(s);

  /*
   * Speed, revs and the tell-tales are all vehicle instruments, so the whole
   * cluster goes away on foot rather than reading 3 mph in top gear with a
   * dead tacho beneath it.
   *
   * This guards rather than returns: street, district and wanted level all
   * still apply on foot, and they are updated further down.
   */
  $('#speedo').hidden = !s.inVehicle;

  if (s.inVehicle) {
    const kmh = s.speed * 3.6;
    $('#speedValue').textContent = Math.round(settings.units === 'kmh' ? kmh : kmh * 0.621371);
    $('#speedUnit').textContent = settings.units === 'kmh' ? 'km/h' : 'mph';

    // Tacho. RPM arrives normalised 0..1, so it needs no scaling.
    const hasRpm = Number.isFinite(s.rpm);
    $('#rpmBar').hidden = !hasRpm;
    if (hasRpm) {
      const frac = Math.max(0, Math.min(1, s.rpm));
      $('#rpmFill').style.transform = 'scaleX(' + frac.toFixed(3) + ')';
      $('#rpmFill').classList.toggle('over', frac >= RPM_REDLINE);
    }

    /*
     * Tell-tales. Each is always in the DOM and lit by class, so the row keeps
     * its width and nothing jumps as states change. Full beam takes precedence
     * over side lights: it is the stronger signal, and the one worth being
     * reminded of.
     */
    $('#statusRow').hidden = false;
    /*
     * Engine, by condition rather than by switch. Health runs 0..1000 and the
     * plugin sends it raw, so these thresholds live here and can be retuned
     * without a rebuild and a reload.
     */
    const eh = Number.isFinite(s.engineHealth) ? s.engineHealth : ENGINE_MAX;
    const engineState = (s.onFire || eh <= ENGINE_DEAD) ? 'warn'
                      : eh < ENGINE_HURT                ? 'caution'
                      : s.engineRunning                 ? 'on'
                      : '';
    setTellTale($('#stEngine'), engineState,
                s.onFire            ? 'Engine on fire'
                : eh <= ENGINE_DEAD ? 'Engine destroyed'
                : eh < ENGINE_HURT  ? 'Engine damaged'
                : s.engineRunning   ? 'Engine running'
                : 'Engine off');
    /*
     * Lights. Broken outranks the switch, because once a unit is gone what the
     * switch says stops mattering — and one out is a caution while both is a
     * warning, the same grammar as the tyres.
     *
     * The per-side natives are trusted for the count and the "both" native as
     * a floor, so a vehicle the game reports as having no headlights at all
     * still reads as unlit.
     */
    const outCount = (s.headlightL ? 1 : 0) + (s.headlightR ? 1 : 0);
    const bothOut = !!s.headlightsGone || outCount >= 2;
    const lightState = bothOut          ? 'warn'
                     : outCount === 1   ? 'caution'
                     : s.highBeams      ? 'beam'
                     : s.lightsOn       ? 'on'
                     : '';
    setTellTale($('#stLights'), lightState,
                bothOut          ? 'No working headlights'
                : outCount === 1 ? 'One headlight out'
                : s.highBeams    ? 'Full beam'
                : s.lightsOn     ? 'Lights on'
                : 'Lights off');
    /*
     * Tyres. One flat is a caution; more than one is a genuine emergency, and
     * the difference is worth a colour rather than a count nobody can read at
     * this distance.
     */
    const flats = Number.isFinite(s.tyresBurst) ? s.tyresBurst : 0;
    setTellTale($('#stTyres'), flats > 1 ? 'warn' : flats === 1 ? 'caution' : '',
                flats === 0 ? 'Tyres intact'
                : flats === 1 ? 'One flat tyre'
                : flats + ' flat tyres');

    const gear = $('#gear');
    const showGear = Number.isFinite(s.gear) && s.gear > 0;
    gear.hidden = !showGear;
    if (showGear) gear.textContent = s.gear;
  }

  // Vehicle card — absent entirely on foot, rather than showing empty fields.
  const vehicleCard = $('#vehicleCard');
  if (s.inVehicle) {
    vehicleCard.hidden = false;
    /*
     * Make above model, on separate lines. On one line a long name like
     * "Albany Cavalcade" set the width of the whole card, and the make is the
     * half you can lose — GET_MAKE_NAME_FROM_VEHICLE_MODEL does not answer for
     * every model, so the make line simply collapses when it is absent.
     */
    $('#vehicleMake').textContent = s.vehicleMake || '';
    $('#vehicleModel').textContent = s.vehicleDisplayName || 'Vehicle';

    const colour = $('#vehicleColour');
    const swatch = colourSwatch(s.vehicleColor);
    colour.textContent = prettyColour(s.vehicleColor);
    colour.hidden = !s.vehicleColor;
    if (swatch) colour.style.setProperty('--swatch', swatch);

    // The plate is a block of its own now, so the number goes inside it.
    const plate = $('#vehiclePlate');
    $('#vehiclePlateNumber').textContent = s.licensePlate || '';

    /*
     * Wear whichever design the vehicle actually has.
     *
     * The real artwork is preferred when the setup tool has extracted it: the
     * banner, stickers and rivets are then the game's own, and all we add is
     * the registration in our own font, in the colour the style calls for.
     * Without it, fall back to drawing an approximation in CSS.
     */
    const art = plateArt && plateArt[s.plateStyle];
    const ps = PLATE_STYLES[s.plateStyle] || PLATE_DEFAULT;
    plate.classList.toggle('has-art', !!art);

    if (art) {
      plate.style.setProperty('--plate-img', 'url("plates/' + art.file + '")');
      plate.style.setProperty('--plate-bg', art.bg);
      plate.style.setProperty('--plate-ink', art.ink);
    } else {
      plate.style.removeProperty('--plate-img');
      plate.style.setProperty('--plate-bg', ps.bg);
      plate.style.setProperty('--plate-edge', ps.edge);
      plate.style.setProperty('--plate-ink', ps.ink);
      plate.style.setProperty('--plate-band', ps.band);
      $('#plateState').textContent = ps.text;
    }
    plate.hidden = !s.licensePlate;
  } else {
    vehicleCard.hidden = true;
  }

  // Street and district
  $('#streetName').textContent = s.streetName || 'Off-road';
  $('#streetSub').textContent =
    [s.crossingStreet ? 'near ' + s.crossingStreet : null, s.zoneName]
      .filter(Boolean).join(' · ');

  updateVignette(s.wantedLevel || 0);
}

/**
 * Wanted level as a vignette. Intensity rides a single custom property so one
 * CSS rule covers every level, and only opacity/background animate — the
 * marker keeps moving smoothly underneath.
 */
function updateVignette(level) {
  const el = $('#vignette');
  const on = settings.vignette && level > 0;
  el.classList.toggle('on', on);
  el.classList.toggle('flash', on);
  el.style.setProperty('--w', on ? (level / 5).toFixed(2) : '0');
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
  settings.transformSource = 'manual';   // survives a re-run of the setup tool
  save();
  trailPts = []; trailEvents = [];
  redrawTrail(); drawEvents();
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
  // Fall back to the calibration the setup tool derived from the game, not to
  // nothing — starting over by hand is almost never what you want.
  settings.transform = installedTransform;
  settings.transformSource = installedTransform ? 'auto' : null;
  save();
  calPoints.forEach(p => { p.game = null; p.img = null; });
  pickingIndex = -1;
  document.body.classList.remove('picking');
  if (!settings.transform && marker) { marker.remove(); marker = null; markerSvg = null; }
  trailPts = []; trailEvents = [];
  redrawTrail(); drawEvents();
  renderCal();
  if (imageBounds && !settings.transform) map.fitBounds(imageBounds);
  toast(installedTransform
    ? 'Reset to the calibration derived from your game files.'
    : 'Calibration cleared.');
}

// --------------------------------------------------------------------------
// UI wiring
// --------------------------------------------------------------------------
function setFollow(on) {
  settings.follow = on;
  const btn = $('#btnFollow');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  save();
}

function wireUi() {
  // --- settings drawer -------------------------------------------------
  const panel = $('#panel');
  const settingsBtn = $('#settingsBtn');
  const setPanel = open => {
    panel.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
  };
  settingsBtn.addEventListener('click', () => setPanel(panel.hidden));
  $('#panelClose').addEventListener('click', () => setPanel(false));

  // --- map controls ----------------------------------------------------
  const btnFollow = $('#btnFollow');
  const syncFollow = () => btnFollow.setAttribute('aria-pressed', String(settings.follow));
  syncFollow();
  btnFollow.addEventListener('click', () => {
    setFollow(!settings.follow);
    // Following while zoomed out far enough to see the whole island does
    // nothing — maxBounds leaves nowhere to pan — so a lit button would sit
    // there looking broken. Zoom to the follow level instead.
    if (settings.follow && current && settings.transform) {
      awaitingFirstFix = true;
    }
  });

  const btnTrail = $('#btnTrail');
  const syncTrail = () => btnTrail.setAttribute('aria-pressed', String(settings.trailVisible));
  syncTrail();
  btnTrail.addEventListener('click', () => {
    settings.trailVisible = !settings.trailVisible;
    save();
    syncTrail();
    redrawTrail(); drawEvents();
  });

  $('#btnRecentre').addEventListener('click', () => {
    if (current && settings.transform) {
      map.setView(gameToLatLng(current.x, current.y), modeZoom(!!current.inVehicle));
    } else if (imageBounds) {
      map.fitBounds(imageBounds);
    }
  });

  const btnFs = $('#btnFullscreen');
  btnFs.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {
      toast('The browser refused fullscreen — try F11.');
    });
  });
  document.addEventListener('fullscreenchange', () => {
    btnFs.setAttribute('aria-pressed', String(!!document.fullscreenElement));
  });

  const btnHide = $('#btnHideUi');
  const syncHidden = () => {
    $('#hud').hidden = settings.uiHidden;
    document.body.classList.toggle('ui-hidden', settings.uiHidden);
    btnHide.setAttribute('aria-pressed', String(settings.uiHidden));
    btnHide.title = settings.uiHidden ? 'Show interface' : 'Hide interface';
    btnHide.querySelector('use').setAttribute('href', settings.uiHidden ? '#i-eye-off' : '#i-eye');
  };
  syncHidden();
  btnHide.addEventListener('click', () => {
    settings.uiHidden = !settings.uiHidden;
    if (settings.uiHidden) setPanel(false);
    save();
    syncHidden();
  });

  // --- zoom ------------------------------------------------------------
  const autoZoom = $('#autoZoomToggle');
  autoZoom.checked = settings.autoZoom;
  autoZoom.addEventListener('change', () => {
    settings.autoZoom = autoZoom.checked;
    save();
  });

  const zv = $('#zoomVehicleInput'), zf = $('#zoomFootInput');
  zv.value = settings.zoomVehicle;
  zf.value = settings.zoomFoot;
  const readZoom = (input, key) => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    settings[key] = Math.max(-5, Math.min(3, v));
    input.value = settings[key];
    save();
  };
  zv.addEventListener('change', () => readZoom(zv, 'zoomVehicle'));
  zf.addEventListener('change', () => readZoom(zf, 'zoomFoot'));

  // --- display ---------------------------------------------------------
  $$('input[name=units]').forEach(radio => {
    radio.checked = radio.value === settings.units;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.units = radio.value;
      save();
    });
  });

  const vig = $('#vignetteToggle');
  vig.checked = settings.vignette;
  vig.addEventListener('change', () => {
    settings.vignette = vig.checked;
    save();
    updateVignette(current ? (current.wantedLevel || 0) : 0);
  });
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('#vignetteHint').textContent =
      'Your system asks for reduced motion, so the pulse is replaced by a ' +
      'static rim that still tracks the wanted level.';
  }

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

  const trail = $('#trailRange');
  trail.value = settings.trailLength;
  $('#trailOut').value = settings.trailLength;
  trail.addEventListener('input', () => {
    settings.trailLength = Number(trail.value);
    $('#trailOut').value = trail.value;
    save();
    while (trailPts.length > settings.trailLength) trailPts.shift();
    redrawTrail(); drawEvents();
  });

  // Legend, built from TRAIL_COLOURS so there is one source of truth.
  const legend = $('#trailLegend');
  Object.keys(TRAIL_COLOURS).forEach(key => {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = TRAIL_COLOURS[key];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(TRAIL_LABELS[key] || key));
    legend.appendChild(item);
  });

  $('#trailClear').addEventListener('click', () => {
    trailPts = []; trailEvents = [];
    redrawTrail(); drawEvents();
  });

  // Map image
  $('#setupFile').addEventListener('change', e => pickImage(e.target.files[0]));
  $('#mapFile').addEventListener('change', e => pickImage(e.target.files[0]));

  // "I've run setup" — re-check without needing a page reload.
  $('#setupRetry').addEventListener('click', async () => {
    const status = $('#setupStatus');
    status.textContent = 'Checking…';

    const manifest = await fetchManifest();

    // A tiled map needs a CRS chosen at map-creation time, so once setup has
    // produced one the only honest way to pick it up is a reload.
    if (manifestHasTiles(manifest)) {
      status.textContent = 'Map found — reloading…';
      location.reload();
      return;
    }

    if (manifest && await applyManifest(manifest)) {
      $('#setup').hidden = true;
      renderCal();
      toast(settings.transform
        ? 'Map installed and calibrated automatically.'
        : 'Map installed.');
    } else {
      status.textContent =
        'Still no map found. Check the setup tool finished without errors, and ' +
        'that GTA V is running so the plugin can serve it.';
    }
  });

  // Coming back to the tab: ask for a fresh sample straight away rather than
  // waiting for the next scheduled poll, so the settling window is enough.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    becameVisibleAt = performance.now();
    if (!settings.mock) pollOnce();
  });

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
/**
 * Map installed by the setup tool, if there is one. Kept so Reset returns to
 * the game-derived calibration rather than to nothing.
 */
let installedTransform = null;

/**
 * Tries the map the setup tool installed into the plugin's web root. Served
 * over the local HTTP feed, so unlike a hand-picked image it is present on
 * every device that opens the page and survives browser storage being cleared.
 */
function serverBase() {
  return (settings.server || '').trim().replace(/\/+$/, '');
}

/*
 * The real plate artwork, extracted from the game by the setup tool.
 *
 * Null until it loads, and it may stay null: the artwork is Rockstar's, so it
 * is never committed and only exists once the ripper has been run against your
 * own install. The CSS-drawn plate in PLATE_STYLES is the fallback for that,
 * and for any style the artwork does not cover.
 */
let plateArt = null;

async function fetchPlateArt() {
  try {
    const r = await fetch(serverBase() + '/plates/plates.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

/*
 * The protagonist portraits — the same pictures the in-game phone shows
 * against a contact. Null until loaded, and it may stay null: Rockstar
 * artwork, extracted from your own install and never committed.
 */
let portraitArt = null;

async function fetchPortraits() {
  try {
    const r = await fetch(serverBase() + '/portraits/portraits.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

/**
 * The character avatar: their phone portrait, ringed in the colour the game
 * uses for them. Both come from the game — the colour is read with
 * GET_HUD_COLOUR rather than being a guess at "Franklin green".
 *
 * Without the artwork it falls back to an initial on that same colour, and
 * without a recognised character to a neutral "?".
 */
function updateAvatar(s) {
  const el = $('#avatar');
  const name = s.character || null;
  const known = !!name;

  el.classList.toggle('known', known);
  if (s.characterColor) el.style.setProperty('--char-colour', s.characterColor);
  else el.style.removeProperty('--char-colour');

  const hasArt = !!(known && portraitArt && portraitArt[name]);
  el.classList.toggle('has-portrait', hasArt);
  if (hasArt) el.style.setProperty('--char-portrait', 'url("portraits/' + portraitArt[name] + '")');
  else el.style.removeProperty('--char-portrait');

  /*
   * The player arrow takes the same colour, set on the root so the marker
   * picks it up wherever Leaflet has parented it. Falls back to the app accent
   * for a character the game does not name.
   */
  if (s.characterColor) document.documentElement.style.setProperty('--player-colour', s.characterColor);
  else document.documentElement.style.removeProperty('--player-colour');

  $('#avatarInitial').textContent = known ? name.charAt(0) : '?';
  el.title = known ? name : 'Character';
}

/** The setup tool's manifest, or null if setup has not been run. */
async function fetchManifest() {
  try {
    const r = await fetch(serverBase() + '/map/map.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function manifestHasTiles(m) {
  return !!(m && m.tiles && m.width && m.height);
}

async function applyManifest(manifest) {
  const base = serverBase();
  try {
    if (manifestHasTiles(manifest)) {
      setMapTiles(base, manifest);
    } else {
      // Older setup output, or tiling failed — fall back to the single image.
      const name = manifest.image || 'gtav-map.png';
      const img = await fetch(base + '/map/' + name);
      if (!img.ok) return false;
      await setMapImage(await img.blob(), name);
    }

    // The setup tool reads the world rectangle the map covers straight out of
    // the game's minimap tuning, so an installed map arrives already calibrated
    // and never needs the two-landmark dance.
    if (isValidTransform(manifest.transform)) {
      installedTransform = manifest.transform;

      // Adopt it unless the user has calibrated by hand. Re-running setup at a
      // different resolution changes the transform, and keeping a stale one
      // would silently put the marker in the wrong place by exactly the ratio
      // of the two map sizes.
      if (!settings.transform || settings.transformSource !== 'manual') {
        settings.transform = manifest.transform;
        settings.transformSource = 'auto';
        save();
      }
    }

    return true;
  } catch (e) {
    return false;
  }
}

async function loadMap(manifest) {
  if (manifest && await applyManifest(manifest)) {
    $('#setup').hidden = true;
    return;
  }

  try {
    const saved = await idbGet(DB_KEY);
    if (saved && saved.blob) {
      await setMapImage(saved.blob, saved.name);
      $('#setup').hidden = true;
      return;
    }
  } catch (e) {
    console.warn('IndexedDB unavailable:', e);
  }

  $('#setup').hidden = false;
}

async function init() {
  // The manifest has to be read before the map exists: whether we are drawing
  // tiles decides which CRS the map must be created with, and that cannot be
  // changed afterwards.
  const manifest = await fetchManifest();

  // Independent of the map, and not worth blocking it: if the artwork is not
  // there the plate simply draws itself.
  fetchPlateArt().then(a => { plateArt = a; });
  fetchPortraits().then(a => { portraitArt = a; });

  initMap(manifestHasTiles(manifest) ? manifest.height : 0);
  wireUi();

  await loadMap(manifest);
  renderCal();

  startFeed();
  setInterval(updateHud, POLL_MS);
  requestAnimationFrame(frame);
}

init();

})();
