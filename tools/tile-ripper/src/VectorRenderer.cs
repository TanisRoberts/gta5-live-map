using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using CodeWalker.GameFiles;
using CodeWalker.Utils;

namespace GtaLiveMap.TileRipper
{
    /// <summary>
    /// Renders the map from the minimap's vector geometry instead of its raster
    /// tiles, which removes the resolution ceiling entirely.
    ///
    /// The raster tiles are the reason the old map went to mush when zoomed: the
    /// land layer is only 512x512 per tile, so a street a dozen world units wide
    /// lands on about three pixels. The same map exists as geometry in
    /// x64e.rpf\levels\gta5\minimap.rpf, and that can be drawn at any size.
    ///
    /// Vertex format, established by inspecting the declaration rather than
    /// assumed: 16 bytes as XYZ floats then BGRA. Two components, flags 17
    /// (position + colour0), stride 16. Colour is baked per vertex, so nothing
    /// has to be classified by material — which matters because the entire map
    /// uses a single shader.
    ///
    /// Z spans only about -12..15, far too small to be elevation. It is a
    /// draw-order key, and sorting on it is what keeps terrain and sand from
    /// painting over the roads.
    ///
    /// Water is absent from the geometry: the game composites this over the sea
    /// bitmap (minimap.ymt sets eBitmapForPause to MM_BITMAP_VERSION_SEA), so
    /// the sea raster is drawn first as a base layer.
    /// </summary>
    internal sealed class VectorRenderer
    {
        private const int GridCols = 2;
        private const int GridRows = 3;

        private readonly RpfManager _mgr;
        private readonly double _worldMinX, _worldMaxY, _worldW, _worldH;

        public VectorRenderer(RpfManager mgr, double worldMinX, double worldMaxY, double worldW, double worldH)
        {
            _mgr = mgr;
            _worldMinX = worldMinX;
            _worldMaxY = worldMaxY;
            _worldW = worldW;
            _worldH = worldH;
        }

        internal struct Vtx { public float X, Y; public byte R, G, B; }
        internal struct Tri { public Vtx A, B, C; public float Z; }

        /// <summary>True if this installation has the vector geometry at all.</summary>
        public bool Available()
        {
            return MinimapGeometry().Any();
        }

        /// <summary>
        /// Renders to a BGRA buffer of the given size. Returns null if no
        /// geometry could be read.
        /// </summary>
        public byte[] Render(int width, int height, Action<string> log)
        {
            byte[] buf = SeaBase(width, height);
            if (log != null) log("  sea base drawn");

            List<Tri> tris = Collect(log);
            if (tris.Count == 0) return null;
            if (log != null) log("  " + tris.Count.ToString("N0") + " triangles collected");

            // Painter's algorithm on the draw-order key.
            tris.Sort(delegate (Tri p, Tri q) { return p.Z.CompareTo(q.Z); });

            double sx = width / _worldW, sy = height / _worldH;
            long drawn = 0;
            foreach (Tri t in tris)
            {
                if (Triangle(buf, width, height, t, sx, sy)) drawn++;
            }

            if (log != null) log("  " + drawn.ToString("N0") + " triangles rasterised");
            return buf;
        }

        // ------------------------------------------------------------------

        private byte[] SeaBase(int width, int height)
        {
            var buf = new byte[(long)width * height * 4];

            string[] roots =
            {
                @"update\update.rpf\x64\data\cdimages\scaleform_generic.rpf\",
                @"x64b.rpf\data\cdimages\scaleform_generic.rpf\"
            };
            string root = roots.FirstOrDefault(r => _mgr.GetEntry(r + "minimap_sea_0_0.ytd") is RpfFileEntry);

            using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.FromArgb(255, 60, 80, 95));

                if (root != null)
                {
                    int cw = width / GridCols, ch = height / GridRows;
                    for (int row = 0; row < GridRows; row++)
                    {
                        for (int col = 0; col < GridCols; col++)
                        {
                            Bitmap tile = LoadTexture(root + "minimap_sea_" + row + "_" + col + ".ytd");
                            if (tile == null) continue;
                            g.DrawImage(tile, col * cw, row * ch, cw, ch);
                            tile.Dispose();
                        }
                    }
                }

                BitmapData bits = bmp.LockBits(new Rectangle(0, 0, width, height),
                                               ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                Marshal.Copy(bits.Scan0, buf, 0, buf.Length);
                bmp.UnlockBits(bits);
            }

            return buf;
        }

        private Bitmap LoadTexture(string path)
        {
            var entry = _mgr.GetEntry(path) as RpfFileEntry;
            if (entry == null) return null;

            var ytd = new YtdFile();
            ytd.Load(_mgr.GetFileData(path), entry);
            if (ytd.TextureDict == null || ytd.TextureDict.Dict == null) return null;

            foreach (Texture tex in ytd.TextureDict.Dict.Values)
            {
                byte[] px = DDSIO.GetPixels(tex, 0);
                if (px == null) continue;

                var bmp = new Bitmap(tex.Width, tex.Height, PixelFormat.Format32bppArgb);
                BitmapData bits = bmp.LockBits(new Rectangle(0, 0, tex.Width, tex.Height),
                                               ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                Marshal.Copy(px, 0, bits.Scan0, Math.Min(tex.Width * tex.Height * 4, px.Length));
                bmp.UnlockBits(bits);
                return bmp;
            }

            return null;
        }

        private IEnumerable<RpfEntry> MinimapGeometry()
        {
            foreach (RpfFile rpf in _mgr.AllRpfs)
            {
                if (rpf.AllEntries == null) continue;
                foreach (RpfEntry e in rpf.AllEntries)
                {
                    string n = (e.Name ?? "").ToLowerInvariant();
                    if (n.StartsWith("minimap") && n.EndsWith(".ydd")) yield return e;
                }
            }
        }

        private List<Tri> Collect(Action<string> log)
        {
            var list = new List<Tri>(160000);
            int total = 0, failed = 0;
            string firstError = null;

            foreach (RpfEntry e in MinimapGeometry().OrderBy(x => x.Path))
            {
                total++;

                YddFile ydd;
                try
                {
                    ydd = new YddFile();
                    ydd.Load(_mgr.GetFileData(e.Path), (RpfFileEntry)e);
                }
                catch (Exception ex)
                {
                    // One unreadable tile should not lose the map, but silently
                    // swallowing every tile absolutely would — so keep count and
                    // report it rather than quietly producing nothing.
                    failed++;
                    if (firstError == null) firstError = ex.Message;
                    continue;
                }

                if (ydd.Drawables == null) continue;

                foreach (Drawable d in ydd.Drawables)
                {
                    if (d == null || d.AllModels == null) continue;
                    foreach (DrawableModel m in d.AllModels)
                    {
                        if (m == null) continue;
                        foreach (object geom in Enumerate(Get(m, "Geometries")))
                        {
                            AddGeometry(list, geom);
                        }
                    }
                }
            }

            if (failed > 0 && log != null)
            {
                log("  WARNING: " + failed + " of " + total + " geometry files failed to load.");
                log("           first error: " + firstError);
                if (firstError != null && firstError.IndexOf("ShadersGen9Conversion", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    log("           CodeWalker reads that file from the folder holding the exe.");
                    log("           Rebuild with build.ps1, which copies it into place.");
                }
            }

            return list;
        }

        private static void AddGeometry(List<Tri> list, object geom)
        {
            object vd = Get(geom, "VertexData");
            var bytes = Get(vd, "VertexBytes") as byte[];
            var idx = Get(Get(geom, "IndexBuffer"), "Indices") as ushort[];
            int stride = ToInt(Get(vd, "VertexStride"));
            int count = ToInt(Get(vd, "VertexCount"));

            if (bytes == null || idx == null || stride < 16 || count <= 0) return;
            if (bytes.Length < (long)count * stride) count = bytes.Length / stride;

            var verts = new Vtx[count];
            var zs = new float[count];

            for (int i = 0; i < count; i++)
            {
                int o = i * stride;
                verts[i].X = BitConverter.ToSingle(bytes, o + 0);
                verts[i].Y = BitConverter.ToSingle(bytes, o + 4);
                zs[i] = BitConverter.ToSingle(bytes, o + 8);
                verts[i].B = bytes[o + 12];
                verts[i].G = bytes[o + 13];
                verts[i].R = bytes[o + 14];
            }

            for (int i = 0; i + 2 < idx.Length; i += 3)
            {
                int a = idx[i], b = idx[i + 1], c = idx[i + 2];
                if (a >= count || b >= count || c >= count) continue;

                list.Add(new Tri
                {
                    A = verts[a],
                    B = verts[b],
                    C = verts[c],
                    Z = (zs[a] + zs[b] + zs[c]) / 3f
                });
            }
        }

        /// <summary>Barycentric fill, interpolating the per-vertex colours.</summary>
        private bool Triangle(byte[] buf, int w, int h, Tri t, double sx, double sy)
        {
            double x0 = (t.A.X - _worldMinX) * sx, y0 = (_worldMaxY - t.A.Y) * sy;
            double x1 = (t.B.X - _worldMinX) * sx, y1 = (_worldMaxY - t.B.Y) * sy;
            double x2 = (t.C.X - _worldMinX) * sx, y2 = (_worldMaxY - t.C.Y) * sy;

            int minX = (int)Math.Floor(Math.Min(x0, Math.Min(x1, x2)));
            int maxX = (int)Math.Ceiling(Math.Max(x0, Math.Max(x1, x2)));
            int minY = (int)Math.Floor(Math.Min(y0, Math.Min(y1, y2)));
            int maxY = (int)Math.Ceiling(Math.Max(y0, Math.Max(y1, y2)));

            if (maxX < 0 || maxY < 0 || minX >= w || minY >= h) return false;

            minX = Math.Max(minX, 0); minY = Math.Max(minY, 0);
            maxX = Math.Min(maxX, w - 1); maxY = Math.Min(maxY, h - 1);

            double det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
            if (Math.Abs(det) < 1e-12) return false;

            for (int py = minY; py <= maxY; py++)
            {
                for (int px = minX; px <= maxX; px++)
                {
                    double cx = px + 0.5, cy = py + 0.5;
                    double l0 = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) / det;
                    double l1 = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) / det;
                    double l2 = 1 - l0 - l1;

                    // A small negative tolerance closes the hairline cracks that
                    // exact edge tests leave between adjacent triangles.
                    if (l0 < -0.0001 || l1 < -0.0001 || l2 < -0.0001) continue;

                    long o = ((long)py * w + px) * 4;
                    buf[o + 0] = (byte)(l0 * t.A.B + l1 * t.B.B + l2 * t.C.B);
                    buf[o + 1] = (byte)(l0 * t.A.G + l1 * t.B.G + l2 * t.C.G);
                    buf[o + 2] = (byte)(l0 * t.A.R + l1 * t.B.R + l2 * t.C.R);
                    buf[o + 3] = 255;
                }
            }

            return true;
        }

        // --- reflection helpers -------------------------------------------
        // CodeWalker's resource collections implement IEnumerable but throw from
        // GetEnumerator; the real array hangs off .data_items, so that is tried
        // first everywhere below.

        private static int ToInt(object v)
        {
            try { return v == null ? 0 : Convert.ToInt32(v); } catch { return 0; }
        }

        private static object Get(object o, string prop)
        {
            if (o == null) return null;

            PropertyInfo p = o.GetType().GetProperty(prop, BindingFlags.Public | BindingFlags.Instance);
            if (p != null) { try { return p.GetValue(o); } catch { return null; } }

            FieldInfo f = o.GetType().GetField(prop, BindingFlags.Public | BindingFlags.Instance);
            if (f != null) { try { return f.GetValue(o); } catch { return null; } }

            return null;
        }

        private static IEnumerable<object> Enumerate(object v)
        {
            if (v == null) yield break;

            var data = Get(v, "data_items") as IEnumerable;
            if (data != null)
            {
                foreach (object x in data) yield return x;
                yield break;
            }

            var en = v as IEnumerable;
            if (en != null && !(v is string))
            {
                foreach (object x in en) yield return x;
            }
        }
    }
}
