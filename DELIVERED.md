# Delivered

What has shipped, how it was built, and the decisions taken along the way —
particularly the ones that were not obvious at the time, or that were wrong
first.

Outstanding work lives in [TODO.md](TODO.md).

---

## The plugin and the feed

A ScriptHookVDotNet Enhanced plugin runs inside story mode, reads the player's
world position every tick, and serves it as JSON over an `HttpListener` on
localhost. A static web client polls that and draws the player on a map.

**Story mode only.** The script aborts if a network session is detected. There
is no `NETWORK_IS_MULTIPLAYER` in this API, so the guard uses
`NETWORK_IS_SESSION_ACTIVE` and `NETWORK_IS_SESSION_STARTED`.

**The threading contract is the load-bearing design decision.** Every
Game/World/Ped call happens on the script thread. The tick renders the whole
snapshot to an immutable UTF-8 `byte[]` and publishes it with `Volatile.Write`;
HTTP threads only `Volatile.Read` and write bytes. No game object ever crosses
a thread boundary. Nothing throws out of `Tick` — it is wrapped and logged.

**No internet dependency.** The plugin serves both the feed and the client
itself, so it works with the network cable out.

### Finding the plugin's own folder took three attempts

SHVDN shadow-copies plugin assemblies into `%LOCALAPPDATA%\assembly\dl3`, so
`Assembly.Location` returns a real directory that is *not* where the plugin was
deployed. The first attempt tested only for existence and stopped at the shadow
copy. The second assumed `AppDomain.BaseDirectory` was the game root, when it is
actually the `scripts` folder, so it looked for `scripts\scripts`. The third
gathers every candidate and picks whichever one actually contains `LiveMap.dll`.

The bug suppressed the log that would have explained it, which is why `/health`
now reports `baseDirectory`, `appDomainBase`, `webRoot` and
`servingStaticFiles`. That endpoint is what made it findable.

---

## 1. Satnav UI rebuild — DONE

Replaced the single control panel with corner cards floating over a full-bleed
map: signal light top-left, clock and settings and avatar top-right, vehicle
card bottom-left, street card bottom-centre, speedometer and map controls
bottom-right, hide-UI below them and outside `#hud` so it survives hiding.

### a. Map controls and speedometer

Recentre, toggle trail, toggle follow, fullscreen, hide UI.

The speedometer began as a bar scaled to the vehicle's estimated top speed, and
became a **tacho** instead: scaling a bar to top speed only duplicated the
number above it, where revs say something the digits do not. `CurrentRPM`
arrives already normalised 0..1. There is no readable redline anywhere in the
API, so the 85% red zone is our own choice and is marked as such in both the
plugin and the client.

`Entity.MaxSpeed` is write-only — it sets a limiter — so the estimated top
speed came from `GET_VEHICLE_ESTIMATED_MAX_SPEED` while it was still needed.

**Tell-tales** replaced the reference image's driver aids: engine, lights,
tyres. Each is always in the DOM and lit by class, so the row keeps its width
and nothing jumps. Engine reports condition rather than on/off (amber below 700
health, red at or below 0 or on fire); lights have four states including a red
one for no working headlights; tyres go amber for one flat and red for more.

Health is sent raw so the thresholds live in the client and can be retuned
without a rebuild and a reload.

### b. Vehicle card

Make above model, colour with its swatch, and the registration on a plate.

**Make is available**, contrary to the original scoping.
`GET_MAKE_NAME_FROM_VEHICLE_MODEL` returns a label key ("VAPID") which the text
table resolves to "Vapid". It does not answer for every model, so the model
alone stays the fallback and the make line collapses entirely rather than
leaving a gap.

**The plate uses the game's own artwork.** `TileRipper --plates` pulls all
thirteen designs out of `vehshare.ytd` and the client writes the registration
over them in its own font.

The style-to-texture mapping is confirmed rather than assumed: the base game
ships `plate01`..`plate05` plus `yankton_plate`, and the 2023 patch adds
`plate_mod_01`..`07` — six then seven, against six base enum values and seven
Enhanced-only ones. The extraction prints each sampled background and they agree
with the names (`YellowOnBlack` sampled `#081010`, `YellowOnBlue` `#182850`, all
three `BlueOnWhite` variants `#d8d8d8`).

**The ink colour cannot be sampled**, and trying returned *white* for
`YellowOnBlack`. The characters are not in the plate texture at all — the game
draws them from a separate font atlas — so the sampler had found the border.
Rockstar named five of the base styles after their own colours, which is better
evidence than a sample; the seven branded plates take a colour chosen for
contrast against the background that *was* measured.

The plate is sized from the text: eight characters plus two more for the
margins, so the registration sits about one character in from each end. Scanning
the artwork showed its frame is a single pixel of 256, so that margin is
measured against the full width rather than an inner field.

### c. Character avatar

The plugin identifies the protagonist from the player ped model and sends
`character` with `characterColor`. The avatar is their phone portrait, ringed in
that colour, and the player arrow takes the same colour.

**The colour is read, not chosen.** `GET_HUD_COLOUR` with `HudColor.Michael` /
`Franklin` / `Trevor` returns the game's own values — Franklin is `#abedab` and
Michael `#65b4d4` because the game says so, and a patch that retunes them is
followed automatically. Resolved only when the ped model changes, since four
`OutputArgument`s are not worth allocating twenty times a second.

**The portrait and the phone contact picture are the same asset.**
`char_michael.ytd` and friends in `scaleform_generic.rpf` hold one 64x64 texture
each, which is exactly what the in-game phone shows against a contact. Two ideas
for this item turned out to be one file.

Fallbacks: a known character with no artwork shows their initial on their
colour; an unrecognised ped shows a neutral "?" rather than an invented
identity.

**Trevor's colour is still unconfirmed** — he was not unlocked in the save used
for development. It is the one guessed value left, and is marked as such in the
mock.

### d. Street card — street half only

`streetName`, `crossingStreet` and `zoneName` all ship. The **next direction**
half is still blocked on routing and has moved to item 3c: better an honest card
showing where you are than a fake one pretending to route.

The district originally appeared both here and on its own top-left card. That
duplication was in the spec, was obvious once seen in place, and the top-left
card was removed — the signal light took that corner instead.

### e. Wanted-level vignette

A red and blue rim that flashes, with spread and intensity tracking the wanted
level, respecting `prefers-reduced-motion` and behind a toggle.

**It never appeared, and was not broken.** `#map` was `position: absolute` with
`z-index: auto`, which creates *no stacking context*, so Leaflet's internal
panes (tile 200, overlay 400, marker 600, popup 700) escaped into the root
context and competed with our own layers as siblings. The vignette at 300 landed
between the tile pane and the overlay pane, and the full-screen trail canvas
painted straight over it. Giving `#map` `z-index: 0` confines those panes and
makes our layering mean what it says.

The paint stack was what proved it — `CANVAS.leaflet-zoom-animated z=100` above
`#vignette z=300` — after forcing the element to solid red still showed nothing,
which ruled out the gradient.

---

## 2. In-game clock — DONE

A clock left of the settings cog, with a sun or moon following the game's own
day/night cycle. It also spends `gameHour` and `gameMinute`, which the plugin
had been sending twenty times a second with nothing reading them.

**The switching hours are researched, not guessed.** GTA V's timecycle files
(`common/data/timecycle/w_*.xml`) hold 13 keyframes per property on the engine's
fixed hours `0, 5, 6, 7, 10, 12, 16, 17, 19, 20, 21, 22, 24`. Those hours are
not in the file, so the mapping needed a check: in `w_extrasunny.xml` the sun
term `light_dir_mult` reads

```
0.2  0.0  5.0  10.0  32.0  64.0  52.0  40.0  22.0  12.0  5.0  0.0  0.2
```

peaking at **64.0 on keyframe 5**, which that mapping says is noon. Sun
brightest at midday is the confirmation. The term is exactly zero at 05:00 and
22:00, so the sun contributes nothing outside 06:00–21:00.

So: moon 22:00–04:59, plain sun 06:00–20:59, and a tinted sun at 05:00 and 21:00
where the sun is genuinely still contributing. All 24 hours were stepped through
and verified.

---

## 4. Trail colour-coded by vehicle type — DONE

The trail is a run of polyline segments split wherever the category changes,
with a dark casing under each so it reads over pale roads and near-black terrain
alike. Categories are mapped client-side from `vehicleClass` — a display name
would have meant maintaining a lookup table.

### The palette was re-keyed twice, both times for a real reason

**First**, because the arrow and the trail were competing for the same channel.
Michael sat 4 degrees from the car blue and 11 from the boat green; Trevor 11 and
12 from other and foot. Only Franklin was clear. Changing one trail colour would
have moved the problem rather than solved it, because the character colours are
spread across the wheel too.

**Second**, because the game's own satnav draws its route in roughly `#ffd23f`,
and a trail in the same yellow reads as a route you are meant to be following —
jarring during a mission. Yellow is now **reserved for when we draw real
navigation ourselves** and the palette comment says so.

Current: car blue, on foot near-white grey, bike jade, boat purple, aircraft
red, other magenta. Hues are checked rather than eyeballed — the closest
chromatic pair is magenta and red at 35 degrees, everything else 44 or more, and
on foot is near-neutral so it sits outside that contest.

The grey is brighter than "whitish grey" suggests, deliberately: the map roads
sit around 198 luminance, and a mid grey would have landed within about 14 of
that and read as road with a dark outline rather than as a colour.

**The arrow is separated by something other than hue** — a dark edge with a
white glow outside it, over a dark shadow. That holds for any character colour,
including Trevor's unconfirmed one. A white edge alone was tried first and
failed exactly where it mattered: Franklin is the palest character colour, and
on the near-white walking trail a pale arrow with a white edge and a white glow
was three pale things stacked.

---

## 4b. Trail breaks on death and arrest — DONE

Dying used to draw a straight line from where you fell to the hospital — a route
never travelled, rendered exactly like one that was.

**The first implementation inferred the respawn from the size of the position
jump, and could not work.** Time stops during the wasted sequence, so the feed
goes quiet and then delivers one sample far away. `sampleAt` then interpolates
between the two over many frames — dozens of small steps, none individually
impossible — so the plausibility test never fired, and that interpolation drew
the very line the test existed to catch. The check was downstream of the thing
hiding the evidence.

**The game's own flags have neither problem, so they drive it now.** The marker
drops on the first sample reporting you down, which is exactly where it
happened; nothing is recorded at all while you are down; and the first sample
back on your feet starts a new run. None of it depends on how far the respawn
moved you or how long the feed was quiet.

Jump detection survives, but only for mission warps and fast travel, where there
is no flag to read and no cause worth inventing. Classification runs on raw
samples at ingestion, and `sampleAt` no longer interpolates across a classified
one.

---

## 5a. Tiled base map — DONE

The setup tool writes a `{z}/{x}/{y}` pyramid, about 2,000 tiles over six
levels. An 8192-wide map is a 19 MB PNG but roughly 400 MB of RGBA once decoded,
and an image overlay holds all of it at every zoom.

Latitude and longitude stay in full-resolution pixels, so the calibration
transform is unchanged.

**Two Leaflet traps, both of which fail silently:**

- `minZoom`/`maxZoom` must be set on the **layer**, not just `minNativeZoom`.
  The layer default `minZoom` is 0, and outside that range Leaflet discards the
  tile zoom and renders nothing.
- The CRS must be chosen when the map is **created**. Tiles need pixels
  projected from the top-left; assigning `map.options.crs` afterwards leaves the
  cached pixel origin describing the old projection.

### Calibration is zero-click

`x64a.rpf\data\tune\minimap.ymt` holds the bitmap's world placement directly —
tile counts, tile size, and the world start corner — which yields the transform
without driving to two landmarks. That the derived `a` and `c` scales come out
equal is a free correctness check, since the projection is isotropic.

---

## 6. Street name in the HUD — DONE

`World.GetStreetName` and `World.GetZoneLocalizedName`, read on the script
thread. Throttled to 4 Hz rather than the 20 Hz position rate, since the street
you are on changes far more slowly than your position — the same pattern later
reused for the burst-tyre walk.

---

## 8. Map drawn from the game's own geometry — DONE

The map is rendered from the minimap's **vector geometry** rather than extracted
from its raster tiles, which removes the resolution ceiling. The raster tiles cap
the road layer at 1024x1536 for the whole map — about three pixels per street.

This was scoped as the largest item in the backlog on the assumption that road
geometry would have to be *derived*. It did not:
`x64e.rpf\levels\gta5\minimap.rpf` holds it directly, with colour baked per
vertex, and CodeWalker parses it. The whole map is ~145,000 triangles and
renders in about two seconds.

Format facts worth keeping:

- Vertices are 16 bytes: XYZ floats then BGRA, declaration flags 17. Colour is
  baked per vertex, so **no material classification is needed** — the whole map
  uses one shader.
- Z spans about -12..15 and is a **draw-order key, not elevation**. Sorting
  triangles by it is what stops terrain and sand painting over roads.
- Water is absent from the geometry; the sea raster is drawn first as a base
  (`minimap.ymt` sets `eBitmapForPause` to `MM_BITMAP_VERSION_SEA`).

**One silent failure worth remembering:** all 65 `.ydd` loads once threw for want
of `ShadersGen9Conversion.xml`, and the collector swallowed the exceptions and
produced an empty map. The build now copies that data file and the loader reports
load failures rather than hiding them.

### What was not done

Rendering happens at setup time and produces raster tiles. Vectors never reach
the browser, so restyling without re-running setup, and crispness beyond the top
zoom level, are both still unclaimed. Both would mean exporting GeoJSON and
drawing it in Leaflet — much smaller now that parsing and projection exist.

---

## Tooling

`tools/tile-ripper` builds CodeWalker.Core from source and references it locally.
CodeWalker is **not vendored**: its notice asserts copyright without granting a
licence, and it contains a GPL component.

Beyond the map, the ripper gained modes that each earned their place answering a
specific question:

| Flag | Answered |
|---|---|
| `--find` | Where does the game keep timecycles / plates / portraits? |
| `--dump` | What is actually in `w_extrasunny.xml`? |
| `--textures` | Which plate textures exist, and how many? |
| `--plates` | Extract the thirteen plate designs |
| `--portraits` | Extract the three protagonist portraits |

**The artwork rule, applied consistently:** the map, the plates and the
portraits are all Rockstar's. Each is extracted from your own install into a
gitignored folder and never committed. `.gitignore` blocks raster formats
repo-wide for exactly this reason.

`tools/reload-plugin.ps1` sends `{INSERT}`, checks the foreground window is
GTA V, and then verifies the plugin timestamp actually reset — an unchanged
value means the game is paused, and a paused game never sees the key.

---

## Things that turned out not to be possible

Recorded so they are not attempted again.

**Fuel does not drain in story mode.** Measured over 72 samples across six
minutes of driving, 52 of them above 5 m/s and peaking at 226 km/h: `FuelLevel`
never moved off 65. Vanilla GTA V does not consume petrol; the level only falls
when the tank is holed. That makes it a damage signal rather than a consumption
one, so it belongs on item 9 rather than in a gauge of its own. It is also a
tank quantity, not a fraction — a percentage needs
`FuelLevel / PetrolTankVolume`, and an electric vehicle reports 0.

**`IS_VEHICLE_STOLEN` does not mean "you stole this."** It is an authored flag
set by mission scripts, not by jacking a car, and read false on every vehicle
tested. `PreviouslyOwnedByPlayer` flips true once you drive something, so it
means the opposite of what would be wanted, and `NeedsToBeHotwired` goes false
the moment you are in. A real signal would have to be derived by watching the
player enter a vehicle and recording the circumstances. The tell-tale was
dropped rather than left showing a flag that never lights.

**There is no way to name the shop you are standing in.** Two routes were
tried against a save parked inside Los Santos Customs.

`GET_INTERIOR_FROM_ENTITY` plus `GET_INTERIOR_LOCATION_AND_NAMEHASH` does
work — it returned a stable, specific `-1070602979` — but it is a hash of an
internal name like `v_carmod3`, so it needs both a table to resolve the hash
and a second hand-written map from that to something readable.

Blips looked better, since `Blip.Name` is a readable string and `BlipSprite`
has named values including `LosSantosCustoms = 72`. It is not: a census found
only **19 blips in the entire world** — Player, North, PersonalVehicleCar,
Safehouse, Chop, Golf, Waypoint, StripClub and similar — with **every single
name empty**. There was no Los Santos Customs blip within 250 metres of
standing inside one, so shop icons are not script blips in single player at
all.

**This changes the scope of item 3a.** Quest markers can be surfaced by sprite,
but the game will not supply their names, so any label has to come from a table
of our own keyed on `BlipSprite`. The player's own blip also has to be excluded
explicitly — it is always the nearest, at distance zero.

**There is no readable maximum RPM**, and no readable redline. `CurrentRPM` is
normalised 0..1, which is its own percentage.

---

## Recurring hazards

Three separate bugs, one cause each, all worth remembering.

**`requestAnimationFrame` stops entirely in a hidden tab**, and timers throttle
to once a second and then once a minute. The trail and the HUD were both
originally driven from rAF, which meant a hidden tab silently lost the route and
froze the HUD while the status still read "Live". Both are now driven from the
sample loop. The same throttling later invalidated several test runs in a hidden
browser pane, where polling had all but stopped and nothing could fire.

**A paused game is not a disconnected one.** It still answers `/pos` — the HTTP
thread is untouched — but the script stops ticking, so the timestamp freezes.
Reporting that as "No signal" sent us chasing a phantom once. There is now a
distinct amber "Paused" state, and the cards deliberately do *not* dim for it:
that data is stopped, not wrong.

**The mock must match the plugin's shape.** It once sent no `vehicleClass`,
which made every mock vehicle read as a car and hid a broken trail-colour path
entirely. Field parity between plugin, client and mock is now audited, and the
mock deliberately exercises the unhappy paths — it dies every 45 seconds
alternating death and arrest, cycles engine damage and flat tyres, walks every
plate design, and rotates the three protagonists.
