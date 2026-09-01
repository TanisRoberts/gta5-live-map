using System;
using System.Globalization;
using System.IO;
using System.Text;

namespace GtaLiveMap
{
    /// <summary>
    /// Append-only log written next to the plugin DLL. Every write is guarded:
    /// a logging failure must never be the thing that takes the game down.
    /// </summary>
    internal static class Log
    {
        private const long MaxBytes = 1024 * 1024;

        private static readonly object Gate = new object();
        private static string _path;

        public static void Init(string directory)
        {
            _path = Path.Combine(directory, "LiveMap.log");
            try
            {
                // Roll rather than grow without bound across many game sessions.
                if (File.Exists(_path) && new FileInfo(_path).Length > MaxBytes)
                {
                    File.Delete(_path);
                }
            }
            catch
            {
                // If we cannot roll it we can probably still append to it.
            }
        }

        public static void Info(string message)
        {
            Write("INFO ", message);
        }

        public static void Warn(string message)
        {
            Write("WARN ", message);
        }

        public static void Error(string message, Exception ex)
        {
            Write("ERROR", ex == null ? message : message + Environment.NewLine + ex);
        }

        private static void Write(string level, string message)
        {
            if (_path == null)
            {
                return;
            }

            lock (Gate)
            {
                try
                {
                    string stamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
                    File.AppendAllText(_path, stamp + "  " + level + "  " + message + Environment.NewLine, Encoding.UTF8);
                }
                catch
                {
                    // Swallowed deliberately — see the class comment.
                }
            }
        }
    }
}
