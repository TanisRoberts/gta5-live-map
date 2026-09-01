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
  README.md
  .gitignore
```

## Status

- [x] Stage 1 — repo skeleton
- [ ] Stage 2 — web client, driven by the mock feed
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

## Quick start

<!-- Filled in at stage 2 (web) and stage 3 (plugin). -->

## Licence / third-party

Leaflet 1.9.4 is vendored under `web/vendor/` (BSD-2-Clause, © Volodymyr Agafonkin
and Leaflet contributors) so the client works with no build step and no CDN.
