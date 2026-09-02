using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace GtaLiveMap.TileRipper
{
    /// <summary>
    /// Slices a rendered map into a {z}/{x}/{y} tile pyramid.
    ///
    /// A single 8192-wide map is a 19 MB PNG, but the browser decodes it to
    /// roughly 400 MB of RGBA and holds all of it at every zoom. Tiles are only
    /// fetched where you are looking, which is what makes a high-resolution map
    /// usable at all — especially on a phone.
    ///
    /// The pyramid is built so that latitude/longitude stay in FULL-RESOLUTION
    /// pixels, which means the calibration transform in map.json needs no
    /// adjustment. Leaflet is given zoom levels running from -maxZoom up to 0,
    /// with tileLayer's zoomOffset mapping those onto folders 0..maxZoom.
    /// </summary>
    internal static class TilePyramid
    {
        public const int TileSize = 256;

        internal sealed class Result
        {
            public int MaxZoom;
            public int TileCount;
            public int Width;
            public int Height;
        }

        /// <summary>
        /// Width snapped to TileSize * 2^n, so every level halves cleanly and the
        /// top level has no partial tiles.
        /// </summary>
        public static int SnapWidth(int width)
        {
            int levels = Math.Max(0, (int)Math.Round(Math.Log((double)width / TileSize, 2)));
            return TileSize * (1 << levels);
        }

        public static Result Write(Bitmap source, string tileDir, Action<string> log)
        {
            int width = source.Width, height = source.Height;

            if (Directory.Exists(tileDir))
            {
                // Stale tiles from a previous run at a different size would be
                // served alongside the new ones and look like corruption.
                Directory.Delete(tileDir, true);
            }
            Directory.CreateDirectory(tileDir);

            int maxZoom = Math.Max(0, (int)Math.Round(Math.Log((double)width / TileSize, 2)));
            var result = new Result { MaxZoom = maxZoom, Width = width, Height = height };

            Bitmap current = source;
            bool ownsCurrent = false;
            try
            {
                for (int z = maxZoom; z >= 0; z--)
                {
                    int written = Slice(current, z, tileDir);
                    result.TileCount += written;

                    if (log != null)
                    {
                        log(string.Format("  z{0}  {1,5} x {2,-5}  {3,5} tiles",
                            z, current.Width, current.Height, written));
                    }

                    if (z == 0) break;

                    Bitmap next = Halve(current);
                    if (ownsCurrent) current.Dispose();
                    current = next;
                    ownsCurrent = true;   // every level below the source is ours
                }
            }
            finally
            {
                if (ownsCurrent) current.Dispose();
            }

            return result;
        }

        private static int Slice(Bitmap level, int z, string tileDir)
        {
            int cols = (level.Width + TileSize - 1) / TileSize;
            int rows = (level.Height + TileSize - 1) / TileSize;
            int written = 0;

            for (int x = 0; x < cols; x++)
            {
                string colDir = Path.Combine(tileDir, z.ToString(), x.ToString());
                Directory.CreateDirectory(colDir);

                for (int y = 0; y < rows; y++)
                {
                    using (var tile = new Bitmap(TileSize, TileSize, PixelFormat.Format32bppArgb))
                    using (var g = Graphics.FromImage(tile))
                    {
                        // Edge tiles are partial; leaving the remainder
                        // transparent lets the map background show through
                        // rather than banding the edge with black.
                        g.Clear(Color.Transparent);

                        int sw = Math.Min(TileSize, level.Width - x * TileSize);
                        int sh = Math.Min(TileSize, level.Height - y * TileSize);
                        if (sw <= 0 || sh <= 0) continue;

                        g.DrawImage(level,
                            new Rectangle(0, 0, sw, sh),
                            new Rectangle(x * TileSize, y * TileSize, sw, sh),
                            GraphicsUnit.Pixel);

                        tile.Save(Path.Combine(colDir, y + ".png"), ImageFormat.Png);
                        written++;
                    }
                }
            }

            return written;
        }

        private static Bitmap Halve(Bitmap src)
        {
            int w = Math.Max(1, src.Width / 2);
            int h = Math.Max(1, src.Height / 2);

            var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.DrawImage(src, 0, 0, w, h);
            }
            return dst;
        }

    }
}
