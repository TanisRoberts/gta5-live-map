# TODO

Future expansion, in priority order as raised. Items marked **DONE** have
shipped; see the stage checklist in [README.md](README.md) for the overall state.

---

## 1. UI rebuild — satnav layout

Replace the single control panel with a Google-Maps-navigation / Uber hybrid:
four corner cards floating over a full-bleed map, no persistent sidebar.

```
┌───────────────────────────────────────────────────────────┐
│ ┌────────┐                                    ⚙  ( ◕ )    │
│ │DISTRICT│                                  cog   avatar  │
│ └────────┘                                                │
│                                                           │
│                        [ M A P ]                          │
│                                                           │
│ ┌──────────────┐                                   ┌───┐  │
│ │ VEHICLE      │                                   │ ⌖ │  │
│ │ model        │        ┌─────────────────┐  ┌──┐  │ ~ │  │
│ │ colour plate │        │ ↰ NEXT DIRECTION│  │65│  │ ⦿ │  │
│ └──────────────┘        │   Street Name   │  │mph│ │ ⛶ │  │
│                         │   district      │  └──┘  ├───┤  │
│                         └─────────────────┘        │ 👁 │  │
│                                                    └───┘  │
└───────────────────────────────────────────────────────────┘
```

- **Bottom centre** — a thin card: next direction and current street, with the
  district small underneath. This is where a satnav puts its instruction, so it
  is the one card that earns centre stage.
- **Top left** — a tiny card showing the current district.
- **Top right** — a small cog icon button and the player avatar in a circle.
  Nothing else; settings live behind the cog.
- **Bottom right** — the map control stack, with the speedometer sitting just to
  its left.

Map controls, top to bottom: **recentre**, **toggle trail**, **toggle follow
player**, **fullscreen**, then **hide UI** separated at the bottom.

**Hide UI** is an eye icon that hides every other card and control — and stays
visible itself, or there is no way back.

This supersedes the old "move Follow player onto the map" item.

**Note:** the district appears both under the street on the bottom-centre card
and on its own top-left card. That is as specified, but it is the same value in
two places — worth revisiting once it can be seen in situ.

### Build order, easiest first

The four corners are **not** equally feasible. Ordered by what actually blocks
them:

**a. Bottom right — map controls + speedometer.** Buildable today. Recentre,
toggle trail, toggle follow, fullscreen, and hide-UI, as a `L.Control` in the
`bottomright` corner rather than a floating div so it moves with the map chrome.
Speed is already in the feed.

Carry over from the old item: follow mode does nothing when zoomed out far
enough to see the whole map, because `maxBounds` leaves nowhere to pan. Harmless
as a checkbox, but a lit-up GPS button that does nothing reads as broken — the
button should zoom to the follow level rather than sit there inert.

**b. Bottom left — vehicle card.** Buildable today; the plugin now sends
everything needed.

| Field | Source |
|---|---|
| Make | `vehicleMake` — `GET_MAKE_NAME_FROM_VEHICLE_MODEL` through the text table |
| Model | `vehicleDisplayName` |
| Colour | `vehicleColor` — an enum name like `MetallicWhite`, or `Custom` |
| Registration | `licensePlate` |

Make **is** available, contrary to what this item said before: the native
returns a label key ("VAPID") which the text table resolves to "Vapid", giving
"Mammoth Patriot" rather than a bare "Patriot". It does not answer for every
model, so the model alone stays the fallback.

**c. Top right — cog button and character avatar — DONE.**

The plugin identifies the protagonist from the player ped model and sends
`character` with `characterColor`. The avatar shows their phone portrait ringed
in that colour.

Two things turned out better than this item expected:

- **The colour is read, not chosen.** `GET_HUD_COLOUR` with `HudColor.Michael`
  / `Franklin` / `Trevor` returns the game's own values, so "Franklin green" is
  `#abedab` because the game says so, and a patch that retunes them is followed
  automatically. It is resolved only when the ped model changes, not per tick.
- **The portrait and the phone picture are the same asset.** `char_michael.ytd`
  and friends in `scaleform_generic.rpf` hold one 64x64 texture each — exactly
  what the in-game phone shows against a contact. So both ideas for this item
  landed on the same file.

The artwork rule still holds: extracted from your own install by
`TileRipper --portraits`, written to the gitignored `web/portraits/`, never
committed. Without it the avatar falls back to the character initial on their
colour, and without a recognised character to a neutral "?" — a mission ped or
a custom skin gets no invented identity.

**d. Bottom centre — next direction and street.** The street half is buildable
today: `streetName`, `crossingStreet` and `zoneName` all ship now.

The **next direction** half is still blocked on routing (item 3c). Build the
card with the street and district working, and leave room for the instruction —
better an honest card that shows where you are than a fake one pretending to
route.

**e. Wanted-level vignette.** A blue and red gradient around the screen edge,
flashing between the two, with the spread and intensity growing as the wanted
level climbs — nothing at zero, a faint rim at one star, an unmistakable pulse
at five.

Buildable today: `wantedLevel` already ships in the feed. Pure CSS and a class
on a full-screen overlay element, `pointer-events: none` so it never eats
clicks, sitting above the map but below the corner cards.

Two things to get right rather than discover later:

- **Do not obscure the map.** The vignette belongs at the very edge, falling off
  fast. The middle of the screen is the part being used.
- **Respect `prefers-reduced-motion`, and add a toggle.** A full-screen red/blue
  flash is exactly the pattern that causes trouble for photosensitive viewers.
  Fall back to a static red rim whose opacity tracks the wanted level, which
  reads just as clearly without the flicker.

Animate opacity and background only, not layout or filters, so it stays off the
main thread while the marker is moving.

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

## 4. Colour-code the trail by vehicle type — DONE

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

Shipped with a legend, a dark casing for contrast against the light vector
map, and coarse categories (car / bike / boat / aircraft / on foot) mapped
client-side from vehicleClass.

## 5. Tiled base map, and switchable layers

### 5a. Move from a single image to tiles — DONE

The setup tool writes a `{z}/{x}/{y}` pyramid (about 2,000 tiles over six
levels) and the client uses `L.tileLayer`. An 8192-wide map is a 19 MB PNG but
roughly 400 MB of RGBA once decoded, and an image overlay holds all of it at
every zoom.

Latitude and longitude stay in full-resolution pixels, so the calibration
transform is unchanged. The plugin's HTTP server already served static files, so
it serves tiles with no change.

Two Leaflet traps worth remembering, both of which fail **silently**:

- `minZoom`/`maxZoom` must be set on the **layer**, not just `minNativeZoom`.
  The layer default `minZoom` is 0, and outside that range Leaflet discards the
  tile zoom and renders nothing.
- The CRS must be chosen when the map is **created**. Tiles need pixels
  projected from the top-left; assigning `map.options.crs` later leaves the
  cached pixel origin describing the old projection.

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

## 9. Vehicle damage indicator

A BeamNG-style damage readout: a top-down schematic of the vehicle with each
part tinted by its condition, so a glance says "front left tyre gone, offside
headlight out" rather than just "damaged".

Everything needed is already readable on the script thread — this is a
plugin-side data item first, and a drawing job second.

| Part | Source |
|---|---|
| Tyres, per wheel | `Vehicle.Wheels` (`VehicleWheelCollection`) |
| Doors, per door | `Vehicle.Doors` (`VehicleDoorCollection`) |
| Windows, per window | `Vehicle.Windows` (`VehicleWindowCollection`) |
| Headlights | `IsLeftHeadLightBroken`, `IsRightHeadLightBroken` |
| Bumpers | `IsFrontBumperBrokenOff`, `IsRearBumperBrokenOff` |
| Overall body | `BodyHealth`, `HasDamageDecals` |
| Engine | `EngineHealth`, `IsOnFire` |
| Petrol tank | `PetrolTankHealth` |
| Rotors (helicopters) | `HeliMainRotorHealth`, `HeliTailRotorHealth` |

**`fuel` already ships in the feed, and belongs here rather than in a gauge of
its own.** It was added to answer whether petrol drains in story mode. Measured
over 72 samples across 6 minutes of driving — 52 of them above 5 m/s, peaking at
226 km/h — `FuelLevel` never moved off 65. Vanilla GTA V does not consume fuel;
the level only falls when the tank is holed, which makes it a **damage** signal,
not a consumption one. Read it alongside `PetrolTankHealth`: a falling level is
a leak, and a leak is worth showing on this schematic.

Note it is a tank quantity, not a fraction — a percentage needs
`FuelLevel / PetrolTankVolume`.

Three things to settle rather than discover later:

- **Do not read this every tick.** The per-part collections mean walking wheels,
  doors and windows on the script thread, at 20 Hz, forever. Damage changes far
  more slowly than position — throttle it the way `PlaceCheckIntervalMs` already
  throttles the street lookup, and consider its own endpoint rather than
  bloating the position payload.
- **Wheel and door counts vary by vehicle**, and a bike has neither doors nor
  four wheels. The schematic has to adapt, or degrade to a simple parts list.
- **The artwork must be ours.** A top-down vehicle silhouette drawn as our own
  SVG, not anything extracted from the game — same rule as the map image and
  the character portraits.

Worth building the parts list first and the schematic second: the list is honest
and useful immediately, and it proves the data before any drawing work.

---

*Item 7 is deliberately last. The MVP is the road map view alone; expand
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

## 8. Vectorised view — DONE (rendered server-side, not vectors in the browser)

The map is now **drawn from the game's own minimap geometry** rather than
extracted from its raster tiles, which removes the resolution ceiling. See
[tools/tile-ripper](tools/tile-ripper/README.md) for the format details.

I had scoped this as the largest item in the backlog on the assumption that road
geometry would have to be *derived*. It did not: `x64e.rpf\levels\gta5\minimap.rpf`
holds it directly, with colour baked per vertex, and CodeWalker parses it. The
whole map is ~145,000 triangles and renders in about two seconds.

### What was NOT done, and is still worth having

Rendering happens at setup time and produces raster tiles. Vectors never reach
the browser, so these benefits are still unclaimed:

- **Restyling without re-running setup.** Colours are baked into the tiles, so a
  night theme or a palette matching item 2 currently means a re-render.
- **Crispness beyond the top zoom level.** Real vectors have no top level.

Both would mean exporting geometry as GeoJSON and drawing it in Leaflet. Much
smaller now that the parsing and projection already exist — the remaining work
is the export and the client rendering.

**The routing link still stands.** This geometry is the road data item 3c needs,
and it is now parsed and projected into world coordinates. Routing is materially
more tractable than when that item was written.
