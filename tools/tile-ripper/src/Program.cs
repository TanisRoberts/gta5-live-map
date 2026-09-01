using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
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
            bool keepTiles = HasFlag(args, "--keep-tiles");

            if (string.IsNullOrEmpty(game))
            {
                Console.Error.WriteLine("usage: TileRipper --game <GTA V folder> [--out <dir>] [--keep-tiles]");
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

                string composite = Path.Combine(outDir, "gtav-map.png");
                Compose(land, sea, composite);

                Dispose(land);
                Dispose(sea);

                Console.WriteLine();
                Console.WriteLine("Done. Map written to:");
                Console.WriteLine("  " + Path.GetFullPath(composite));
                Console.WriteLine();
                Console.WriteLine("Load it in the live map client with 'Choose map image'.");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Failed: " + ex.Message);
                return 1;
            }
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
        private static void Compose(Bitmap[] land, Bitmap[] sea, string outPath)
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
