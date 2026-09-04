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
- [x] Stage 3 — the C# plugin (running in-game)

All three stages are done, along with the satnav HUD, the vector-rendered map,
the in-game clock, plate and portrait artwork, and trail breaks on death.

- **[DELIVERED.md](DELIVERED.md)** — what has shipped, how, and the decisions
  behind it, including the things that turned out not to be possible.
- **[TODO.md](TODO.md)** — what is left.

## Requirements (GTA V **Enhanced**)

This targets **GTA&nbsp;V Enhanced**. Enhanced is a different executable from
Legacy and needs the Enhanced-aware toolchain — the classic Legacy ScriptHookV /
SHVDN3 downloads will not load into it.

| Component | Version | Source |
|---|---|---|
| GTA V Enhanced | `1.0.1158.13` | Steam (appid `3240220`) |
| Script Hook V | `v3889.0 / 1158.13` | [dev-c.com](https://dev-c.com/gtav/scripthookv) |
| ScriptHookVDotNet **Enhanced** | `v1.1.0.6` | [github.com/Chiheb-Bacha/ScriptHookVDotNetEnhanced](https://github.com/Chiheb-Bacha/ScriptHookVDotNetEnhanced) |
| .NET Framework | ≥ 4.8 | — |

Check your game build first (right-click `GTA5_Enhanced.exe` → Properties →
Details). Script Hook V is tied to an exact game patch: after a Rockstar title
update it stops working until a matching release appears, so the version above
must line up with your build.

### Install

Everything except the plugin goes in the **game root** — the folder containing
`GTA5_Enhanced.exe` (a default Steam install is under
`steamapps\common\Grand Theft Auto V Enhanced`).

1. From Script Hook V: `ScriptHookV.dll` and `dinput8.dll` → game root.
2. From ScriptHookVDotNetEnhanced: `ScriptHookVDotNet.asi`,
   `ScriptHookVDotNet2.dll`, `ScriptHookVDotNet3.dll` and the `.ini` → game root.
   Update the `.asi` and the `.dll`s **together**; mismatched versions fail.
3. Create a `scripts\` folder in the game root if there isn't one. The built
   plugin DLL goes there — see the plugin section.

### BattlEye must be disabled — this is a required step

Enhanced ships **BattlEye** (`BattlEye\`, `GTA5_Enhanced_BE.exe`), and it is
active in **story mode**, not just online. Because Script Hook V injects code,
BattlEye treats it as a threat and kills the process — so with BattlEye running
this plugin does not work at all.

On Steam: **right-click the game → Properties → General → Launch Options**, and
enter:

```
-nobattleye
```

Clearing that box re-enables it. Launch options live in your Steam user config
rather than the game folder, so unlike deleting files they survive game updates
and *Verify integrity of game files*.

To confirm it worked, start story mode and check nothing is running:

```
Get-Process BEService_x64,BEService -ErrorAction SilentlyContinue
```

No output means BattlEye did not load.

**Disabling it locks you out of GTA Online**, which is a feature here rather than
a cost: you cannot accidentally join a session with the plugin loaded. You get a
"BattlEye is required to play GTA Online" screen instead.

### Story mode only

Three independent layers keep this out of multiplayer:

1. BattlEye disabled — GTA Online refuses to launch.
2. Script Hook V — closes GTA V if a multiplayer session is entered.
3. This plugin — aborts itself if it detects an online session.

**The real ban risk is going online with mod files present and detected**, which
can mean suspension, a character reset, or a permanent ban. If you later want to
play Online, re-enable BattlEye **and** remove the ASI files first — do not rely
on just one of the two.

Rockstar do not officially support single-player mods and reserve the right to
act. Nothing here is a guarantee; the risk is yours to accept.

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

Run the setup tool once — see [tools/tile-ripper](tools/tile-ripper/README.md).
It reads the map out of your own GTA V installation, installs it into the
client, and works out the calibration from the game's own data.

```
powershell -ExecutionPolicy Bypass -File tools\tile-ripper\build.ps1 `
    -Game "<your GTA V folder>"
```

Then open the client. There is nothing else to configure: the map appears and
the marker is already in the right place.

Open the client before running setup and you get a **"Setup hasn't been run
yet"** screen with that command and an *I've run it — check again* button.

To try the UI without the game at all, turn on **Mock feed** in the panel — a
synthetic player drives a loop.

### Calibration

**Normally you do not calibrate anything.** The setup tool reads
`minimap.ymt` from the game, which states exactly which world rectangle the map
bitmap covers:

```
2 x 3 tiles of 4500 x 4500 units, starting at world (-4140, 8400)
=> world X -4140..4860, Y -5100..8400
```

That yields an exact transform, written into `map/map.json` and applied
automatically. A useful sanity check falls out of it: the X and Y scales come
out identical, as they must for a real map projection.

The manual two-landmark method below is the fallback for a map image the setup
tool did not produce — your own screenshot, or a community map. **Reset** returns
to the game-derived calibration when there is one.

To calibrate by hand you use two landmarks:

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

## The plugin

A ScriptHookVDotNet 3 script that samples the player each tick and serves the
result over HTTP.

### Threading

The single rule the design is built around: **the script thread is the only
thread that touches the GTA API.** Once per tick it reads the world, renders the
result to a UTF-8 byte array, and publishes that array with a volatile write.
HTTP threads only ever take a volatile read of that reference and write the bytes
to a socket — they never see a game object, so there is nothing to race on and no
lock to contend.

Serialising on the script thread rather than handing over a struct is deliberate:
it means no game-derived value *can* be read off-thread, whatever later changes
do. This matters more on Enhanced than on Legacy, because SHVDNE runs scripts on
a dedicated thread and notes that scripts assuming otherwise may break.

Nothing propagates out of `OnTick` — an exception escaping it can take the game
down, so the body is wrapped and errors are logged (and rate-limited after ten).

### Build

Needs `ScriptHookVDotNet3.dll` to compile against, so install
ScriptHookVDotNetEnhanced first.

```
powershell -ExecutionPolicy Bypass -File plugin\build.ps1 -Deploy
```

This uses the C# compiler that ships with .NET Framework 4.8 — **no .NET SDK,
Visual Studio or MSBuild required**. The tradeoff is C# 5 syntax only. Sources
are pinned to `LangVersion 5` so the optional `LiveMap.csproj` agrees.

`-Deploy` copies `LiveMap.dll` into `<game>\scripts\`, writes a default
`LiveMap.ini` if there isn't one, and copies `web/` to `<game>\scripts\LiveMapWeb\`.
Without it, the DLL is left in `plugin\bin\` for you to place yourself.

### Configure

`LiveMap.ini` sits next to the DLL — see
[LiveMap.ini.example](plugin/LiveMap.ini.example) for every setting. Port
defaults to 8088.

Binding `http://+:8088/` so phones can reach it needs a one-off reservation.
Without it the plugin **falls back to localhost and says so in the log**, along
with the exact commands. Run these once in an admin prompt:

```
netsh http add urlacl url=http://+:8088/ user=%USERDOMAIN%\%USERNAME%
netsh advfirewall firewall add rule name="GTA V Live Map" dir=in action=allow protocol=TCP localport=8088
```

### Check it is alive

Load story mode, then before opening the map:

```
curl http://localhost:8088/health
curl http://localhost:8088/pos
```

`/health` returns `{"ok":true}`. `/pos` returns the snapshot — call it twice and
confirm `t` advances and `x`/`y` change as you move. Then open
<http://localhost:8088/> for the map, or `http://<this-pc-ip>:8088/` from a phone.

`LiveMap.log` sits next to the DLL and records startup, the bound address, config
values and any errors. It is the first place to look if `/pos` does not answer.

> **Gotcha:** the map image and calibration are stored per browser *origin*. Testing
> on `localhost:8099` via `tools/serve.ps1` and then switching to the plugin on
> `:8088` means picking the image and calibrating again. Same for viewing from a
> phone by IP.

## Licence / third-party

This project is MIT licensed — see [LICENSE](LICENSE).

Leaflet 1.9.4 is vendored under `web/vendor/` so the client works with no build
step and no CDN. It is BSD-2-Clause; its licence text is retained alongside it at
[web/vendor/LICENSE-leaflet.txt](web/vendor/LICENSE-leaflet.txt).

No Rockstar assets are included, and none should ever be committed here — the
`.gitignore` blanket-ignores raster image formats to keep it that way. Your map
image stays in your browser.
