using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Xml.Linq;
using CodeWalker.GameFiles;
using CodeWalker.Utils;

namespace GtaLiveMap.TileRipper
{
    /// <summary>
    /// Extracts the minimap tiles from a GTA V installation and composites them
    /// into a single map image for the live map client.
    ///
    /// Reads only — nothing is written back to the game. The output is derived
    /// from the game files of whoever runs it, so it stays on their machine and
    /// is deliberately never committed to this repository.
    ///
    /// The tiles live in scaleform_generic.rpf as .ytd texture dictionaries
    /// named minimap_{row}_{col}, over a grid 2 wide and 3 tall. GTA V's map is
    /// portrait, so the FIRST index is the row. Treating it as 3x2 produces a
    /// scrambled map — that is the obvious symptom if this is ever changed.
    /// </summary>
    internal static class Program
    {
        private const int GridCols = 2;
        private const int GridRows = 3;

        private static readonly string[] SearchRoots =
        {
            // The update archive overrides the base game, so prefer it.
            @"update\update.rpf\x64\data\cdimages\scaleform_generic.rpf\",
            @"x64b.rpf\data\cdimages\scaleform_generic.rpf\"
        };

        private static RpfManager _mgr;

        private static int Main(string[] args)
        {
            string game = Arg(args, "--game", null);
            string outDir = Arg(args, "--out", "map-out");
            string source = Arg(args, "--source", "vector");
            bool keepTiles = HasFlag(args, "--keep-tiles");

            int width;
            if (!int.TryParse(Arg(args, "--width", "8192"), out width)) width = 8192;
            width = TilePyramid.SnapWidth(Math.Max(1024, Math.Min(16384, width)));

            if (string.IsNullOrEmpty(game))
            {
                Console.Error.WriteLine("usage: TileRipper --game <GTA V folder> [--out <dir>]");
                Console.Error.WriteLine("                 [--source vector|raster] [--width N] [--keep-tiles]");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  --source  vector (default) renders the minimap geometry, which has no");
                Console.Error.WriteLine("            resolution limit. raster uses the low-res minimap textures.");
                Console.Error.WriteLine("  --width   output width in pixels, 1024-16384. Default 8192.");
                return 2;
            }

            if (!Directory.Exists(game))
            {
                Console.Error.WriteLine("Game folder not found: " + game);
                return 2;
            }

            Directory.CreateDirectory(outDir);

            try
            {
                // Enhanced and Legacy use different archive formats. Detect from
                // which executable is present rather than asking the user.
                bool gen9 = File.Exists(Path.Combine(game, "GTA5_Enhanced.exe"));
                Console.WriteLine("Edition: " + (gen9 ? "Enhanced (gen9)" : "Legacy"));

                Console.WriteLine("Loading encryption keys from the game executable...");
                GTA5Keys.LoadFromPath(game, gen9, null);

                Console.WriteLine("Scanning archives (this takes a moment)...");
                _mgr = new RpfManager();
                _mgr.Init(game, gen9, delegate { }, delegate { }, false, false);
                Console.WriteLine("  " + _mgr.AllRpfs.Count + " archives");

                Projection proj = ReadProjection();
                string composite = Path.Combine(outDir, "gtav-map.png");
                Size size = Size.Empty;

                // Prefer the vector geometry: the raster tiles cap the road layer
                // at 1024x1536 for the whole map, which is about three pixels per
                // street. The geometry has no such ceiling.
                if (!string.Equals(source, "raster", StringComparison.OrdinalIgnoreCase) && proj != null)
                {
                    var vector = new VectorRenderer(_mgr, proj.StartX, proj.StartY, proj.WorldW, proj.WorldH);
                    if (vector.Available())
                    {
                        int height = (int)Math.Round(width * proj.WorldH / proj.WorldW);
                        Console.WriteLine("Rendering from vector geometry at " + width + " x " + height + " ...");

                        byte[] buf = vector.Render(width, height, Console.WriteLine);
                        if (buf != null)
                        {
                            SaveBuffer(buf, width, height, composite);
                            size = new Size(width, height);
                        }
                        else
                        {
                            Console.WriteLine("  no geometry could be read; falling back to the raster tiles.");
                        }
                    }
                    else
                    {
                        Console.WriteLine("No minimap geometry in this installation; using the raster tiles.");
                    }
                }

                if (size == Size.Empty)
                {
                    string root = FindRoot();
                    if (root == null)
                    {
                        Console.Error.WriteLine("Could not find the minimap tiles in this installation.");
                        return 1;
                    }

                    Console.WriteLine("Tiles found under: " + root);
                    Console.WriteLine();

                    Bitmap[] sea = LoadGrid(root, "minimap_sea_{0}_{1}.ytd", outDir, keepTiles);
                    Bitmap[] land = LoadGrid(root, "minimap_{0}_{1}.ytd", outDir, keepTiles);

                    size = Compose(land, sea, composite);

                    Dispose(land);
                    Dispose(sea);
                }

                Console.WriteLine();
                Console.WriteLine("Map written to:");
                Console.WriteLine("  " + Path.GetFullPath(composite));

                // Hand the map to the client rather than making the user pick it
                // from a file dialog. The client loads it over HTTP, so it works
                // on any device and survives the browser storage being cleared.
                string deploy = Arg(args, "--deploy", null);
                if (string.IsNullOrEmpty(deploy))
                {
                    string guess = Path.Combine(game, "scripts", "LiveMapWeb");
                    if (Directory.Exists(guess))
                    {
                        deploy = guess;
                    }
                }

                if (!string.IsNullOrEmpty(deploy))
                {
                    Deploy(deploy, composite, size, gen9, proj);
                }
                else
                {
                    Console.WriteLine();
                    Console.WriteLine("The live map client was not found, so the map was not installed.");
                    Console.WriteLine("Pass --deploy <path to LiveMapWeb>, or load the PNG by hand with");
                    Console.WriteLine("'Choose map image' in the client.");
                }

                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Failed: " + ex.Message);
                return 1;
            }
        }

        /// <summary>
        /// The world rectangle the map bitmap covers, read from the game's own
        /// minimap tuning rather than guessed or calibrated by hand.
        /// </summary>
        private sealed class Projection
        {
            public int TilesX, TilesY;
            public double TileW, TileH;
            public double StartX, StartY;

            public double WorldW { get { return TilesX * TileW; } }
            public double WorldH { get { return TilesY * TileH; } }
        }

        /// <summary>
        /// Reads minimap.ymt for the bitmap's world placement. This is what makes
        /// calibration unnecessary: the game states exactly which world rectangle
        /// the tiles cover, so the image-to-world transform is exact rather than
        /// fitted from two landmarks the player has to drive between.
        /// </summary>
        private static Projection ReadProjection()
        {
            try
            {
                const string path = @"x64a.rpf\data\tune\minimap.ymt";
                var entry = _mgr.GetEntry(path) as RpfFileEntry;
                if (entry == null) return null;

                var ymt = new YmtFile();
                ymt.Load(_mgr.GetFileData(path), entry);

                string unused;
                string xml = MetaXml.GetXml(ymt, out unused);
                if (string.IsNullOrWhiteSpace(xml)) return null;

                var bitmap = XDocument.Parse(xml).Descendants("Bitmap").FirstOrDefault();
                if (bitmap == null) return null;

                var p = new Projection
                {
                    TilesX = (int)Attr(bitmap, "iBitmapTilesX", "value"),
                    TilesY = (int)Attr(bitmap, "iBitmapTilesY", "value"),
                    TileW = Attr(bitmap, "vBitmapTileSize", "x"),
                    TileH = Attr(bitmap, "vBitmapTileSize", "y"),
                    StartX = Attr(bitmap, "vBitmapStart", "x"),
                    StartY = Attr(bitmap, "vBitmapStart", "y")
                };

                if (p.TilesX <= 0 || p.TilesY <= 0 || p.TileW <= 0 || p.TileH <= 0) return null;

                // The grid we composite must match the grid the game describes,
                // or the transform would describe a different image than the one
                // we just built.
                if (p.TilesX != GridCols || p.TilesY != GridRows)
                {
                    Console.WriteLine("  note: game reports a " + p.TilesX + "x" + p.TilesY +
                                      " grid but tiles were composited as " + GridCols + "x" + GridRows +
                                      "; skipping automatic calibration.");
                    return null;
                }

                return p;
            }
            catch (Exception ex)
            {
                Console.WriteLine("  note: could not read the map projection (" + ex.Message + ").");
                return null;
            }
        }

        private static double Attr(XElement parent, string element, string attribute)
        {
            var el = parent.Element(element);
            if (el == null) throw new InvalidOperationException("missing <" + element + ">");
            var at = el.Attribute(attribute);
            if (at == null) throw new InvalidOperationException("missing " + element + "/@" + attribute);
            return double.Parse(at.Value, CultureInfo.InvariantCulture);
        }

        private static string FindRoot()
        {
            foreach (string root in SearchRoots)
            {
                if (_mgr.GetEntry(root + "minimap_0_0.ytd") is RpfFileEntry)
                {
                    return root;
                }
            }

            return null;
        }

        /// <summary>Loads the grid row-major, so index = row * GridCols + col.</summary>
        private static Bitmap[] LoadGrid(string root, string pattern, string outDir, bool keepTiles)
        {
            Bitmap[] grid = new Bitmap[GridRows * GridCols];

            for (int row = 0; row < GridRows; row++)
            {
                for (int col = 0; col < GridCols; col++)
                {
                    string name = string.Format(pattern, row, col);
                    Bitmap bmp = LoadTexture(root + name);
                    grid[row * GridCols + col] = bmp;

                    if (bmp == null)
                    {
                        Console.WriteLine("  missing " + name);
                        continue;
                    }

                    Console.WriteLine(string.Format("  {0,-28} {1}x{2}", name, bmp.Width, bmp.Height));

                    if (keepTiles)
                    {
                        string tile = Path.Combine(outDir, Path.GetFileNameWithoutExtension(name) + ".png");
                        bmp.Save(tile, ImageFormat.Png);
                    }
                }
            }

            return grid;
        }

        private static Bitmap LoadTexture(string path)
        {
            RpfFileEntry entry = _mgr.GetEntry(path) as RpfFileEntry;
            if (entry == null)
            {
                return null;
            }

            YtdFile ytd = new YtdFile();
            ytd.Load(_mgr.GetFileData(path), entry);

            if (ytd.TextureDict == null || ytd.TextureDict.Dict == null)
            {
                return null;
            }

            foreach (Texture tex in ytd.TextureDict.Dict.Values)
            {
                // Level 0 is the full-resolution mip. GetPixels decodes the
                // block-compressed data to straight BGRA, which is the byte
                // order a 32bppArgb Bitmap expects in memory.
                byte[] pixels = DDSIO.GetPixels(tex, 0);
                if (pixels == null)
                {
                    continue;
                }

                Bitmap bmp = new Bitmap(tex.Width, tex.Height, PixelFormat.Format32bppArgb);
                BitmapData bits = bmp.LockBits(new Rectangle(0, 0, tex.Width, tex.Height),
                                               ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                Marshal.Copy(pixels, 0, bits.Scan0, Math.Min(tex.Width * tex.Height * 4, pixels.Length));
                bmp.UnlockBits(bits);

                return bmp;   // one texture per minimap dictionary
            }

            return null;
        }

        /// <summary>
        /// Sea tiles carry the water detail at twice the resolution of the land
        /// tiles, so they set the output size and are drawn first. The land
        /// layer goes over the top, scaled to match.
        /// </summary>
        private static Size Compose(Bitmap[] land, Bitmap[] sea, string outPath)
        {
            int cell = 0;
            cell = Math.Max(cell, LargestCell(sea));
            cell = Math.Max(cell, LargestCell(land));

            if (cell == 0)
            {
                throw new InvalidOperationException("No tiles were loaded.");
            }

            int width = GridCols * cell;
            int height = GridRows * cell;

            Console.WriteLine();
            Console.WriteLine("Compositing " + width + " x " + height + "...");

            using (Bitmap canvas = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(canvas))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.FromArgb(255, 60, 80, 95));

                DrawLayer(g, sea, cell);
                DrawLayer(g, land, cell);

                canvas.Save(outPath, ImageFormat.Png);
            }

            return new Size(width, height);
        }

        /// <summary>
        /// Installs the map into the client's web root, alongside a manifest the
        /// client looks for on startup. Doing it over HTTP rather than through
        /// the file picker means the map is there on every device that opens the
        /// page, and survives the browser's storage being cleared.
        /// </summary>
        private static void Deploy(string webRoot, string composite, Size size, bool gen9, Projection proj)
        {
            string mapDir = Path.Combine(webRoot, "map");
            Directory.CreateDirectory(mapDir);

            string image = Path.Combine(mapDir, "gtav-map.png");
            File.Copy(composite, image, true);

            // Tiles, so the client fetches only what is on screen. A single
            // 8192-wide map decodes to ~400 MB of RGBA in the browser and is
            // held at every zoom; tiles make high resolution actually usable.
            TilePyramid.Result tiles = null;
            try
            {
                Console.WriteLine();
                Console.WriteLine("Building tile pyramid...");
                using (var bmp = new Bitmap(image))
                {
                    tiles = TilePyramid.Write(bmp, Path.Combine(mapDir, "tiles"), Console.WriteLine);
                }
            }
            catch (Exception ex)
            {
                // Not fatal: the client falls back to the single image.
                Console.WriteLine("  tiling failed (" + ex.Message + ")");
                Console.WriteLine("  the client will use the single image instead.");
                tiles = null;
            }

            var parts = new List<string>
            {
                "  \"image\": \"gtav-map.png\"",
                "  \"width\": " + size.Width,
                "  \"height\": " + size.Height,
                "  \"source\": \"GTA V " + (gen9 ? "Enhanced" : "Legacy") + " minimap\"",
                "  \"generated\": \"" + DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") + "\""
            };

            if (tiles != null)
            {
                parts.Add("  \"tiles\": { \"path\": \"tiles/{z}/{x}/{y}.png\", \"tileSize\": " +
                          TilePyramid.TileSize + ", \"maxZoom\": " + tiles.MaxZoom +
                          ", \"count\": " + tiles.TileCount + " }");
            }

            if (proj != null)
            {
                // Client convention: lng = a*worldX + b, lat = c*worldY + d,
                // where lat counts UP from the image's bottom edge. The bitmap
                // start is its north-west corner, so world Y decreases as the
                // image row increases — which is where the flip is absorbed.
                // Tiles keep lat/lng in full-resolution pixels, so this stays
                // correct whether the client draws tiles or the single image.
                double a = size.Width / proj.WorldW;
                double c = size.Height / proj.WorldH;
                double b = -proj.StartX * a;
                double d = size.Height - proj.StartY * c;

                parts.Add("  \"transform\": { \"a\": " + N(a) + ", \"b\": " + N(b) +
                          ", \"c\": " + N(c) + ", \"d\": " + N(d) + " }");
                parts.Add("  \"world\": { \"minX\": " + N(proj.StartX) +
                          ", \"maxX\": " + N(proj.StartX + proj.WorldW) +
                          ", \"minY\": " + N(proj.StartY - proj.WorldH) +
                          ", \"maxY\": " + N(proj.StartY) + " }");
            }

            File.WriteAllText(Path.Combine(mapDir, "map.json"),
                              "{\n" + string.Join(",\n", parts.ToArray()) + "\n}\n");

            Console.WriteLine();
            Console.WriteLine("Installed into the live map client:");
            Console.WriteLine("  " + mapDir);

            if (proj != null)
            {
                Console.WriteLine();
                Console.WriteLine("Calibration derived from the game's own minimap tuning:");
                Console.WriteLine(string.Format("  world {0:0} x {1:0} units, X {2:0}..{3:0}, Y {4:0}..{5:0}",
                    proj.WorldW, proj.WorldH, proj.StartX, proj.StartX + proj.WorldW,
                    proj.StartY - proj.WorldH, proj.StartY));
                Console.WriteLine("  No manual calibration needed.");
            }
            else
            {
                Console.WriteLine();
                Console.WriteLine("Could not derive calibration automatically — you will need to");
                Console.WriteLine("calibrate by hand in the client.");
            }

            Console.WriteLine();
            Console.WriteLine("Setup complete. Start GTA V story mode, then open:");
            Console.WriteLine("  http://localhost:8088/");
        }

        private static string N(double v)
        {
            return v.ToString("0.#########", CultureInfo.InvariantCulture);
        }

        private static void SaveBuffer(byte[] buf, int width, int height, string path)
        {
            using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                BitmapData bits = bmp.LockBits(new Rectangle(0, 0, width, height),
                                               ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                Marshal.Copy(buf, 0, bits.Scan0, buf.Length);
                bmp.UnlockBits(bits);
                bmp.Save(path, ImageFormat.Png);
            }
        }

        private static int LargestCell(Bitmap[] grid)
        {
            int max = 0;
            foreach (Bitmap b in grid)
            {
                if (b != null && b.Width > max)
                {
                    max = b.Width;
                }
            }
            return max;
        }

        private static void DrawLayer(Graphics g, Bitmap[] grid, int cell)
        {
            for (int row = 0; row < GridRows; row++)
            {
                for (int col = 0; col < GridCols; col++)
                {
                    Bitmap bmp = grid[row * GridCols + col];
                    if (bmp != null)
                    {
                        g.DrawImage(bmp, col * cell, row * cell, cell, cell);
                    }
                }
            }
        }

        private static void Dispose(Bitmap[] grid)
        {
            foreach (Bitmap b in grid)
            {
                if (b != null)
                {
                    b.Dispose();
                }
            }
        }

        private static string Arg(string[] args, string name, string fallback)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                {
                    return args[i + 1];
                }
            }
            return fallback;
        }

        private static bool HasFlag(string[] args, string name)
        {
            foreach (string a in args)
            {
                if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
