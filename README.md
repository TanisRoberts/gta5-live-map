# gta5-live-map

A live map companion for **GTA V story mode**. A ScriptHookVDotNet 3 plugin reads
the player's world position each tick and serves it as JSON over HTTP on your LAN.
A static web page polls that JSON and draws you as a marker on a map image you
supply, so you can keep a live map open on a second screen or your phone.

> **Story mode only.** ScriptHookV does not load in GTA Online, and this plugin
> additionally aborts itself if it ever detects an online session. See
> [Story mode only](#story-mode-only).

## Layout

```
gta5-live-map/
  plugin/     C# ScriptHookVDotNet 3 plugin (.NET Framework 4.8 class library)
  web/        static client (index.html, app.js, style.css, vendor/leaflet)
  tools/      serve.ps1 — local static server for working on the client
  README.md
  .gitignore
```

## Status

- [x] Stage 1 — repo skeleton
- [x] Stage 2 — web client, driven by the mock feed
- [ ] Stage 3 — the C# plugin

## Story mode only

ScriptHookV refuses to load in GTA Online, so this code cannot run there. On top
of that, the plugin checks for an online session on startup and on every tick,
and aborts itself if one is detected. There is no networking code that talks to
anything but your own LAN.

## Bring your own map image

This repo contains **no Rockstar artwork**, and `.gitignore` is set up to keep it
that way — raster image formats are ignored repo-wide. You pick your own map
image in the web client on first run; it is stored in your browser's IndexedDB
and remembered across reloads.

## The web client

Once the plugin exists it serves `web/` itself and you just browse to it. To work
on the client on its own — with the game shut — serve the folder locally:

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

Then open <http://localhost:8099>.

Open it over `http://` rather than double-clicking `index.html`: browsers refuse
IndexedDB on `file://` origins, so your map image would not be remembered.

### First run

1. **Choose a map image.** Any image of the map works. It is stored in your
   browser and never uploaded. Nothing is bundled with this repo.
2. **Turn on _Mock feed_** in the panel. A synthetic player drives a loop, so you
   can set everything up and check it works before the plugin is involved.
3. **Calibrate** (below).

### Calibration

The client has no idea how your image relates to game coordinates until you tell
it, using two landmarks:

1. Stand somewhere recognisable in game. Click **Capture position** under
   Point&nbsp;A — that records your world coordinates.
2. Click **Pick on map**, then click that same spot on the image.
3. Drive somewhere **far away** — ideally the opposite corner of the map — and
   repeat for Point&nbsp;B.
4. Click **Apply**.

It solves an independent scale and offset for X and Y (no rotation or shear, and
the game/image Y inversion falls out of the solve). The result is saved in
`localStorage`; **Reset** clears it.

Two sanity checks will stop you wasting time on a bad calibration:

- Landmarks less than 500 world units apart on either axis are rejected — at that
  spacing a few pixels of click error throws the marker right off across the rest
  of the map.
- If the solved X and Y scales disagree by more than 25%, it warns you. A normal
  north-up map image is scaled the same on both axes, so a mismatch almost always
  means a point was clicked in the wrong place.

### Controls

| | |
|---|---|
| **Follow player** | Recentre on the player each frame vs. free panning. Dragging the map turns it off. Note it can do nothing while you are zoomed far enough out to see the whole map, since there is nowhere to pan to. |
| **Trail** | Breadcrumb length, 0–2000 points, with a clear button. |
| **Server** | Leave blank to use the page's own origin — correct when the plugin is serving the page. Set it to e.g. `http://192.168.1.20:8088` if you are opening the client from somewhere else. |
| **Mock feed** | Drive the marker from a synthetic loop instead of HTTP. |

The HUD shows speed in mph, current vehicle, wanted level, in-game time, and raw
world coordinates.

### How the marker moves

`/pos` is polled at ~10 Hz while the plugin ticks at ~20 Hz. Rather than jumping
the marker on each response, samples go into a short buffer keyed on the plugin's
own monotonic timestamp, and the marker is drawn 250 ms behind live, interpolated
between the two samples that bracket that instant. That keeps network jitter out
of the motion and means the marker glides. Heading is interpolated along the
shortest arc, and the arrow is rotated through the calibration transform so it
points along the path as actually drawn.

If the endpoint is down, polling backs off to a couple of seconds rather than
hammering it ten times a second.

## Licence / third-party

Leaflet 1.9.4 is vendored under `web/vendor/` (BSD-2-Clause, © Volodymyr Agafonkin
and Leaflet contributors) so the client works with no build step and no CDN.
