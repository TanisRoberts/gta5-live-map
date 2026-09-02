# Tile ripper

Extracts the minimap tiles from **your own** GTA V installation and composites
them into a single map image for the live map client.

Reads only — nothing is written back to the game.

## Why this exists

The client needs a picture of the map. The alternatives were all worse:

- Screenshotting the in-game pause map bakes in blips, the legend and your own
  marker, and is limited to your screen resolution.
- Scraping a third-party map site takes someone else's bandwidth and someone
  else's compilation work.
- Driving a modding GUI by hand is a fiddly manual process to repeat.

This reads the tiles straight out of the archives you already own, at native
resolution, with no HUD baked in.

## The output is yours, and stays local

The composite is derived from Rockstar's artwork in your game files. It belongs
on your machine and **must never be committed** — the repository's `.gitignore`
blocks raster image formats specifically to prevent that. The tool writes
outside the repo by default.

## Requirements

The .NET SDK:

```
winget install Microsoft.DotNet.SDK.8
```

Plus `git`, which `build.ps1` uses to fetch CodeWalker.

## Why CodeWalker is not vendored here

GTA V's `.rpf` archives are encrypted and compressed, with the keys held in the
game executable. Implementing that from scratch is years of reverse engineering,
so this tool uses [CodeWalker](https://github.com/dexyfex/CodeWalker)'s
file-format code — via `CodeWalker.Core`.

It is **not** committed to this repository, and cannot be. CodeWalker's
`Notice.txt` asserts `Copyright(c) 2017-2019 dexyfex` **without granting a
licence**, and the project also contains a GPL-licensed component. Public source
is not permission to redistribute, and either issue alone would conflict with
this repository's MIT licence.

So `build.ps1` clones and builds it on your machine and references the result
locally — the same arrangement the plugin has with `ScriptHookVDotNet3.dll`.

## Usage

Build and rip in one go:

```
powershell -ExecutionPolicy Bypass -File tools\tile-ripper\build.ps1 `
    -Game "D:\SteamLibrary\steamapps\common\Grand Theft Auto V Enhanced" `
    -Out "$env:USERPROFILE\Pictures\gtav-map"
```

Or build once and run the exe directly afterwards:

```
tools\tile-ripper\bin\Release\net48\TileRipper.exe --game "<GTA V folder>" --out map-out
```

| Flag | |
|---|---|
| `--game` | GTA V install folder. Enhanced and Legacy are both detected automatically. |
| `--out` | Output folder. Default `map-out`. |
| `--keep-tiles` | Also write the individual tiles, not just the composite. |
| `--plates` | Extract the thirteen number-plate designs instead of the map, plus `plates.json`. |
| `--portraits` | Extract the three protagonist phone portraits, plus `portraits.json`. |
| `--find <text>` | List archive paths containing `text`. Research aid. |
| `--dump <path>` | Write one file out of the archives. Research aid. |
| `--textures <path>` | List the textures inside a `.ytd`. Research aid. |

Output is `gtav-map.png` plus a `{z}/{x}/{y}` tile pyramid, 8192 x 12288 by
default.

The client expects the extra artwork under `web/`, so run those two against it:

```
TileRipper.exe --game "<GTA V folder>" --plates    --out web
TileRipper.exe --game "<GTA V folder>" --portraits --out web
```

Both write into gitignored folders. The artwork is Rockstar's and stays on
your machine, exactly like the map.

## Why the map is drawn, not extracted

The obvious approach — pulling out the minimap's raster tiles — caps the road
layer at 1024 x 1536 for the whole map. At that scale a street a dozen world
units wide lands on about **three pixels**, so zooming in just magnifies mush.

The same map also exists as **geometry**, in `x64e.rpf\levels\gta5\minimap.rpf`.
Drawing that has no resolution ceiling, and it is fast — around 145,000
triangles, a couple of seconds. Three things about the format, all established
by inspecting it rather than assuming:

- Vertices are 16 bytes: XYZ floats then BGRA. Colour is **baked per vertex**,
  so nothing needs classifying by material — which matters, because the entire
  map shares one shader and the material tells you nothing.
- Every alpha is 255. Transparency is not involved.
- Z spans only about -12 to 15, far too small to be elevation. It is a
  **draw-order key**; sorting on it is what stops terrain and sand painting over
  the roads. Skip that step and the output is unusable.

Water is absent from the geometry — the game composites over the sea bitmap
(`minimap.ymt` sets `eBitmapForPause` to `MM_BITMAP_VERSION_SEA`), so the sea
raster is drawn first as a base layer.

Pass `--source raster` for the old low-resolution path; it is also the automatic
fallback if the geometry cannot be read.

## Why tiles

An 8192-wide map is a 19 MB PNG but roughly **400 MB of RGBA** once the browser
decodes it, and a single image overlay holds all of it at every zoom. The
pyramid (about 2,000 tiles over six levels) means only what is on screen is
fetched.

Latitude and longitude stay in full-resolution pixels, so the calibration
transform is identical either way.

If the client is found at `<game>\scripts\LiveMapWeb` the map is **installed
into it automatically**, along with a `map.json` manifest — open the client and
it is simply there, already calibrated. Pass `--deploy <path>` to install it
somewhere else, or load the PNG by hand with **Choose map image**.

## Calibration comes free

The tool reads `x64a.rpf\data\tune\minimap.ymt`, which states exactly where the
map bitmap sits in the world:

```xml
<iBitmapTilesX value="2" />  <iBitmapTilesY value="3" />
<vBitmapTileSize x="4500" y="4500" />
<vBitmapStart    x="-4140" y="8400" />
```

So the map covers world X `-4140..4860` and Y `-5100..8400`, and the transform
is computed rather than fitted. That matters because the manual alternative —
standing at two landmarks far apart — is impractical on a new save, where most
of the map is a long drive away.

Two things fall out of it that are worth knowing:

- The tile grid the game reports is checked against the grid actually
  composited. A mismatch means the file layout changed, so calibration is
  skipped rather than silently wrong.
- The X and Y scales come out identical, as they must for a real map
  projection. That is a free correctness check on the whole pipeline.

## How it works

1. Detects the edition from which executable is present — Enhanced uses a
   different (gen9) archive format from Legacy.
2. Reads the decryption keys from your game executable.
3. Scans the archives and locates `scaleform_generic.rpf`, preferring the copy
   in `update.rpf` since that overrides the base game.
4. Loads `minimap_{row}_{col}.ytd` and `minimap_sea_{row}_{col}.ytd`, decoding
   the block-compressed textures to raw pixels.
5. Composites sea first, then land over the top.

### The grid gotcha

Tiles are named `minimap_{row}_{col}` over a grid **2 wide and 3 tall**. GTA V's
map is portrait — Blaine County north, Los Santos south — so the *first* index is
the row.

Reading it as 3 wide by 2 tall produces a scrambled map with visibly mismatched
coastlines. If the output ever looks like that, this is why.

Sea tiles are 1024x1024 and land tiles 512x512, so the sea layer sets the output
resolution and the land is scaled over it.
