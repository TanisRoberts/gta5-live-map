# TODO

Outstanding work, in priority order. Completed items and the decisions behind
them have moved to [DELIVERED.md](DELIVERED.md).

Numbering is kept from the original list so older commit messages still point at
the right thing. Items 1, 4, 5a, 6 and 8 are done and are no longer here.

---

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

Some of this already ships for the tell-tales: `engineHealth`, `onFire`,
`tyresBurst`, `headlightL`, `headlightR` and `headlightsGone` are in the feed,
and the throttled per-part read pattern exists.

**`fuel` belongs here** rather than in a gauge of its own — see the fuel finding
in [DELIVERED.md](DELIVERED.md). Read alongside `PetrolTankHealth`, a falling
level is a leak, and a leak is worth showing on this schematic.

Three things to settle rather than discover later:

- **Do not read this every tick.** The per-part collections mean walking wheels,
  doors and windows on the script thread, at 20 Hz, forever. Damage changes far
  more slowly than position — throttle it the way `DamageCheckIntervalMs`
  already throttles the tyre walk, and consider its own endpoint rather than
  bloating the position payload.
- **Wheel and door counts vary by vehicle**, and a bike has neither doors nor
  four wheels. The schematic has to adapt, or degrade to a simple parts list.
- **The artwork must be ours.** A top-down vehicle silhouette drawn as our own
  SVG, not anything extracted from the game — same rule as the map, the plates
  and the character portraits.

Worth building the parts list first and the schematic second: the list is honest
and useful immediately, and it proves the data before any drawing work.

## 3. Quest markers, manual markers, and navigation

Three pieces, increasing in difficulty.

**3a. Quest markers.** Surface the game's own blips on the map. The plugin side
is the new work: read them **on the script thread** like everything else,
serialise into the feed, and map sprite ids to icons on the client. Blips change
rarely compared to the player, so they want their own endpoint or a lower update
rate, not the 20 Hz position payload.

**Scoped down by what a census actually found** (see DELIVERED.md): there are
only about 19 blips in the world at a time, `Blip.Name` is empty on every one of
them, and shop icons like Los Santos Customs are not blips at all. So this
surfaces position, sprite and colour, and any label has to come from a table of
our own keyed on `BlipSprite`. The player's own blip must be excluded — it is
always nearest, at distance zero, and unnamed.

**3b. Manual markers.** Drop pins on the map and have them persist, client-side
only. Independent of the plugin, so it can be done any time.

**3c. Navigation route** *(stretch)*. Draw a route to a marker rather than a
straight line. This also completes the bottom-centre card, whose "next
direction" half is still waiting on it.

Materially more tractable than when this was written: the road geometry is
already parsed and projected into world coordinates by the tile ripper.

**Yellow is reserved for this.** The trail palette deliberately avoids
`#ffd23f`, because that is roughly what the game's own satnav draws its route
in — see the palette note in [DELIVERED.md](DELIVERED.md).

## 2. Visual design language

The current look is dark and functional but has no considered identity. Keep it
dark, with item 1's layout now settled as the frame to design within.

Everything is driven by CSS custom properties at the top of
[web/style.css](web/style.css), so the palette is one place to change. The
structural work is typography, card treatment, spacing, and the marker.

The viewing distance is the constraint that should drive it: this is read from a
sofa, on a second monitor scaled to 150–200%. That argues for far fewer, far
larger, higher-contrast elements than a dense dashboard — closer to a car's head
unit than a web app.

## 5b. Switchable base layers

Hold more than one base map and switch between them. Client-side this is a
Leaflet layer control plus one entry per layer rather than the single map
manifest used today.

**The part to settle first:** one calibration only covers every layer if the
images share dimensions and cover the same area. Plan for **per-layer
calibration** — store the transform against the layer, not globally — and treat
a shared transform as the special case rather than the assumption.

Low value until there is a second layer worth switching to, which means item 7.

## 7. Satellite view

A photographic-style base layer, as an alternative to the road map.

The blocker is sourcing, not code — **GTA V ships no satellite tile set.** Its
map UI only ever draws the road/atlas style, so there is nothing to extract that
already looks like this. The satellite views on community map sites are renders
someone produced from the 3D world.

Realistic routes, none of them cheap:

- Render it from the game's own terrain and map geometry. CodeWalker can view
  the world in 3D; capturing a full orthographic top-down pass over the whole
  map is a project in itself.
- A community-made satellite image whose licence explicitly permits reuse.

Do not scrape third-party tile servers. Whatever the source, it stays local and
never gets committed.

Once an image exists it drops into the layer switcher (5b) and the existing tile
pipeline with no new client work, assuming per-layer calibration is in place —
it will not share dimensions with the road map.

---

## Loose ends

Small things, not worth their own item.

- **Trevor's HUD colour is unconfirmed.** He was not unlocked in the save used
  for development, so the mock carries a guessed value, marked as such. Capture
  it from `GET_HUD_COLOUR` the first time he is playable.
- **Death and arrest markers have never met a real death.** They are verified
  end to end under injected flags, and the plugin sends the real ones, but the
  two halves have not been tested together in game.
- **Vector export for restyling.** See item 8 in [DELIVERED.md](DELIVERED.md):
  the map is rendered to raster tiles at setup time, so a night theme or a
  palette change means re-running the ripper.
