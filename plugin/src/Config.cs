using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace GtaLiveMap
{
    /// <summary>
    /// Settings read from LiveMap.ini next to the DLL. Missing file, missing
    /// keys and junk values all fall back to defaults rather than failing —
    /// a typo in an ini should not stop the game from starting.
    /// </summary>
    internal sealed class Config
    {
        public int Port = 8088;
        public bool BindAllInterfaces = true;
        public int TickHz = 20;
        public string WebRoot = "LiveMapWeb";

        public static Config Load(string directory)
        {
            Config cfg = new Config();
            string path = Path.Combine(directory, "LiveMap.ini");

            if (!File.Exists(path))
            {
                Log.Info("No LiveMap.ini found; using defaults (port " + cfg.Port + ").");
                return cfg;
            }

            try
            {
                Dictionary<string, string> values = Parse(path);

                cfg.Port = ReadInt(values, "port", cfg.Port, 1, 65535);
                cfg.TickHz = ReadInt(values, "tick_hz", cfg.TickHz, 1, 60);
                cfg.BindAllInterfaces = ReadBool(values, "bind_all_interfaces", cfg.BindAllInterfaces);

                string web;
                if (values.TryGetValue("web_root", out web) && web.Length > 0)
                {
                    cfg.WebRoot = web;
                }

                Log.Info("Config: port=" + cfg.Port + " tick_hz=" + cfg.TickHz +
                         " bind_all_interfaces=" + cfg.BindAllInterfaces + " web_root=" + cfg.WebRoot);
            }
            catch (Exception ex)
            {
                Log.Error("Could not read LiveMap.ini; falling back to defaults.", ex);
            }

            return cfg;
        }

        private static Dictionary<string, string> Parse(string path)
        {
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == ';' || line[0] == '#' || line[0] == '[')
                {
                    continue;
                }

                int eq = line.IndexOf('=');
                if (eq <= 0)
                {
                    continue;
                }

                string key = line.Substring(0, eq).Trim();
                string value = line.Substring(eq + 1).Trim();
                values[key] = value;
            }

            return values;
        }

        private static int ReadInt(Dictionary<string, string> values, string key, int fallback, int min, int max)
        {
            string raw;
            if (!values.TryGetValue(key, out raw))
            {
                return fallback;
            }

            int parsed;
            if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
            {
                Log.Warn("Ini key '" + key + "' is not a number ('" + raw + "'); using " + fallback + ".");
                return fallback;
            }

            if (parsed < min || parsed > max)
            {
                Log.Warn("Ini key '" + key + "' out of range " + min + "-" + max + " ('" + raw + "'); using " + fallback + ".");
                return fallback;
            }

            return parsed;
        }

        private static bool ReadBool(Dictionary<string, string> values, string key, bool fallback)
        {
            string raw;
            if (!values.TryGetValue(key, out raw))
            {
                return fallback;
            }

            switch (raw.Trim().ToLowerInvariant())
            {
                case "1":
                case "true":
                case "yes":
                case "on":
                    return true;
                case "0":
                case "false":
                case "no":
                case "off":
                    return false;
                default:
                    Log.Warn("Ini key '" + key + "' is not a boolean ('" + raw + "'); using " + fallback + ".");
                    return fallback;
            }
        }
    }
}
