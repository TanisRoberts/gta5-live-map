# TODO

Future expansion, in priority order as raised. Nothing here is started — see the
stage checklist in [README.md](README.md) for what is actually built.

---

## 1. UI rebuild — satnav layout

Replace the single control panel with a Google-Maps-navigation / Uber hybrid:
four corner cards floating over a full-bleed map, no persistent sidebar.

```
┌─────────────────────────┬─────────────────────────┐
│  NEXT DIRECTION         │        SETTINGS ▾       │
│  (top left)             │   + character avatar    │
│                         │        (top right)      │
│                                                   │
│                  [ M A P ]                        │
│                                                   │
│  VEHICLE CARD           │    MAP CONTROLS         │
│  make / model /         │    + SPEEDOMETER        │
│  colour / plate         │      (bottom right)     │
│  (bottom left)          │                         │
└─────────────────────────┴─────────────────────────┘
```

This supersedes the old "move Follow player onto the map" item — those buttons
are now part of the bottom-right cluster.

### Build order, easiest first

The four corners are **not** equally feasible. Ordered by what actually blocks
them:

**a. Bottom right — map controls + speedometer.** Buildable today, nothing new
needed. Follow and Recentre become icon buttons (a `L.Control` in the
`bottomright` corner, not a floating div, so it moves with the map chrome).
Speed is already in the feed.

Carry over from the old item: follow mode does nothing when zoomed out far
enough to see the whole map, because `maxBounds` leaves nowhere to pan. Harmless
as a checkbox, but a lit-up GPS button that does nothing reads as broken. Either
disable it at that zoom or have it zoom to a sensible follow level.

**b. Bottom left — vehicle card.** Needs three new plugin fields. `vehicleClass`
already ships; make/model, colour and plate do not:

| Field | Where it comes from |
|---|---|
| Model | `Vehicle.LocalizedName` — already sent as `vehicleDisplayName` |
| Make | Not cleanly separable from model in the API; may need a lookup table, or just show the model |
| Colour | `Vehicle.Mods.PrimaryColor` (an enum — needs mapping to a display name and a swatch) |
| Registration | `Vehicle.Mods.LicensePlate` |

Small, contained plugin work. Do it in one pass with item 4's needs.

**c. Top right — settings + character avatar.** Detecting *which* character is
active is easy (compare the player ped's model hash against Michael / Franklin /
Trevor). Two catches:

- **The artwork is Rockstar's.** Character portraits cannot be committed here,
  same rule as the map image. Either generate a neutral avatar (initial, or a
  silhouette in the character's signature colour), or treat portraits as a
  user-supplied local asset like the map.
- Settings content largely already exists — it is the current panel, restyled
  into a dropdown.

**d. Top left — next direction.** **Blocked.** This is turn-by-turn navigation,
which needs routing (item 3c), which needs road geometry the client does not
have. Do not design around this arriving soon.

Worth deciding early: build the card as a placeholder that renders a
straight-line bearing and distance to a manual marker (item 3b). That gives the
layout something real to show, and degrades honestly, without pretending to
route.

## 2. Visual design language

The current look is generic dark-blue. Keep it dark, but give it a considered
identity — now with item 1's layout as the frame to design within.

Everything is already driven by CSS custom properties at the top of
[web/style.css](web/style.css), so the palette is one place to change. The
structural work is typography, card treatment, spacing, and the marker.

The viewing distance is the constraint that should drive it: this is read from a
sofa, on a second monitor scaled to 150–200%. That argues for far fewer, far
larger, higher-contrast elements than a dense dashboard — closer to a car's head
unit than a web app.

## 3. Quest markers, manual markers, and navigation

Three pieces, increasing in difficulty.

**3a. Quest markers.** Surface the game's own blips (missions, activities,
shops) on the map. The plugin side is the new work — the snapshot currently
carries only the player. SHVDN exposes the active blips, with a position, a
sprite id and a colour each; those need reading **on the script thread** like
everything else, serialising into the feed, and mapping sprite ids to icons on
the client. Blips change rarely compared to the player, so they want their own
endpoint or a lower update rate, not the 20 Hz position payload.

**3b. Manual markers.** Let me drop my own pins on the map and have them persist,
client-side only. Independent of the plugin, so it can be done any time.

**3c. Navigation route** *(stretch)*. Draw a route to a marker rather than a
straight line. Needs road geometry the client does not have — see item 6. This is
much the largest item here and should be split out once 3a and 3b land.

## 4. Colour-code the trail by vehicle type

Show which parts of a journey were driven, ridden, sailed or walked, by colouring
each trail segment accordingly (boat, car, bike, on foot, aircraft, …).

The snapshot already carries `inVehicle` and `vehicleDisplayName`, but a display
name is the wrong key to classify on — it would mean maintaining a name lookup.
The plugin should send the vehicle's **class** instead (SHVDN exposes a vehicle
class enum: compacts, sedans, boats, motorcycles, cycles, helicopters, planes and
so on), and the client can group those into a handful of trail colours.

Client-side this means the trail stops being one `L.polyline` and becomes a run
of segments split wherever the class changes. Worth keeping the existing point
budget in mind — the trail is capped at 2000 points and redrawn whenever a point
is added.

Needs a legend, or the colours mean nothing.

## 5. Tiled base map, and switchable layers

### 5a. Move from a single image to tiles

Replace `L.imageOverlay` with `L.tileLayer` so only the visible tiles are
fetched. A 4096×4096 base map decodes to ~67 MB of RGBA in the browser no matter
how small the file is on disk, and `imageOverlay` holds all of it at every zoom —
which matters most on the phone this is meant to be viewed on.

The calibration maths is unaffected: `CRS.Simple` and the game→pixel transform
work the same against a tile pyramid.

Two sources of tiles, and the pipeline should not care which:

- The game's own minimap textures are **already tiled** at native resolution with
  no HUD baked in. Extracting them needs OpenIV or CodeWalker.
- Anything else (a pause-map screenshot, a community render) needs slicing into a
  `{z}/{x}/{y}` pyramid. Worth writing a small slicer using `System.Drawing` —
  no new dependencies.

The plugin's HTTP server already serves static files, so it serves tiles as-is.

### 5b. Switchable layers

Hold more than one base map and switch between them. Client-side this is a
Leaflet layer control plus one entry per layer rather than the single `mapImage`
key used today. See items 7 and 8 for the layers themselves.

**MVP scope is the road map only.** Get one layer working and tested end to end
before any of this.

**The part to settle first:** one calibration only covers every layer if the
images share dimensions and cover the same area. Mixing a pause-map screenshot at
monitor resolution with an extracted 4096×4096 texture will not line up. Given
layers will realistically come from different sources, plan for **per-layer
calibration** — store the transform against the layer, not globally — and treat a
shared transform as the special case rather than the assumption.

Sourcing is the user's problem, not the code's, but for the record: the atlas view
is a pause-map screenshot away; satellite means extracting the terrain texture from
your own `x64*.rpf` (there is no in-game view of it); stylised maps are usually
community work with their own licence terms. **Do not scrape third-party tile
servers**, and never commit any of it — `.gitignore` blocks raster formats
repo-wide for exactly this reason.

## 6. Current street name in the HUD

Show the street you are on, like a phone satnav.

GTA V can resolve a world position to a street name in-game, so the plugin can
read it per tick (on the script thread) and add it to the snapshot — no street
data needs to ship with the client. Cheapest item on this list and the one that
most makes it feel like a satnav.

It only gives the street at a point, not road geometry, so it does **not** on its
own unlock routing (3c) — but it is the natural first step toward it.

---

*Items 7 and 8 are deliberately last. The MVP is the road map view alone; expand
only once that is working and tested.*

## 7. Satellite view

A photographic-style base layer, as an alternative to the road map.

The blocker is sourcing, not code — **GTA V ships no satellite tile set.** Its map
UI only ever draws the road/atlas style, so there is nothing to extract that
already looks like this. The satellite views on community map sites are renders
someone produced from the 3D world.

Realistic routes, none of them cheap:

- Render it from the game's own terrain and map geometry (CodeWalker can view the
  world in 3D; capturing a full orthographic top-down pass over the whole map is
  a project in itself).
- A community-made satellite image whose licence explicitly permits reuse.

Do not scrape third-party tile servers. Whatever the source, it stays local and
never gets committed.

Once an image exists, it drops into the layer switcher (5b) and the tile pipeline
(5a) with no new client work — assuming per-layer calibration is in place, since
it will not share dimensions with the road map.

## 8. Vectorised view

A clean vector rendering — roads, water, district boundaries as paths rather than
a raster image.

Genuinely different from items 5 and 7, and the most work of the three: it is not
an image at all. It would mean deriving road geometry and coastlines and drawing
them as GeoJSON through Leaflet.

What it buys, and why it might be worth it despite the effort:

- Crisp at every zoom, with no tile pyramid and no memory cost.
- Tiny compared with any raster map.
- Styleable — dark mode that actually matches the UI (item 2), or a night theme.
- The road geometry needed here is the **same data routing needs** (item 3c). If
  vectorising ever happens, routing becomes far more tractable as a side effect.

That shared dependency is the argument for doing 8 and 3c together, or not at all.
