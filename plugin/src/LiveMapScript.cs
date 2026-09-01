using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using GTA;
using GTA.Chrono;
using GTA.Math;
using GTA.Native;

namespace GtaLiveMap
{
    /// <summary>
    /// Reads the player's position each tick and publishes it for the HTTP
    /// server to serve. Story mode only.
    ///
    /// Threading contract: this class is the only thing that touches the GTA
    /// API, and it does so only from the script thread inside OnTick. The HTTP
    /// server never sees a game object — it reads a pre-rendered byte array
    /// through <see cref="Feed"/>.
    /// </summary>
    public class LiveMapScript : Script
    {
        /// <summary>How often to re-check for an online session.</summary>
        private const long OnlineCheckIntervalMs = 1000;

        /// <summary>Stop spamming the log if the game API starts failing every tick.</summary>
        private const int MaxLoggedTickErrors = 10;

        private readonly Stopwatch _clock = Stopwatch.StartNew();

        private HttpServer _server;
        private long _nextOnlineCheckMs;
        private int _tickErrors;
        private bool _stopped;

        public LiveMapScript()
        {
            string directory = ".";

            try
            {
                directory = ResolveBaseDirectory();
                Log.Init(directory);
                Log.Info("==== GTA V Live Map starting ====");

                Config config = Config.Load(directory);

                // SHVDN throttles Tick for us; no need to hand-roll the timing.
                Interval = 1000 / config.TickHz;

                _server = new HttpServer(config, directory);
                _server.Start();

                Tick += OnTick;
                Aborted += OnAborted;
            }
            catch (Exception ex)
            {
                // A constructor that throws would take the whole script host
                // down, so fail quietly into a disabled state instead.
                Log.Error("Startup failed; the plugin is disabled for this session.", ex);
                Shutdown();
            }
        }

        /// <summary>
        /// Works out the folder holding this DLL, which is where the ini, the
        /// log and the web root live.
        ///
        /// <see cref="Assembly.Location"/> alone is not enough: SHVDN can load a
        /// script from a byte array, which leaves Location empty and silently
        /// gives us no config, no log and no static files. Fall through a chain
        /// of increasingly blunt options and take the first that resolves to a
        /// real directory.
        /// </summary>
        private static string ResolveBaseDirectory()
        {
            // SHVDN shadow-copies plugin assemblies into the .NET download cache
            // (%LOCALAPPDATA%\assembly\dl3\...), so Assembly.Location returns a
            // real directory that is emphatically NOT where we were deployed —
            // no ini, no web root, and a log nobody will ever find.
            //
            // The game process's base directory is the game root, and SHVDN
            // always loads plugins from <game root>\scripts. Trust that first,
            // and only fall back to asking the assembly where it thinks it is.
            try
            {
                string scripts = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scripts");
                if (Directory.Exists(scripts))
                {
                    return scripts;
                }
            }
            catch { }

            Assembly self = Assembly.GetExecutingAssembly();

            try
            {
                string location = self.Location;
                if (!string.IsNullOrEmpty(location))
                {
                    string dir = Path.GetDirectoryName(location);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                    {
                        return dir;
                    }
                }
            }
            catch { }

            try
            {
                string codeBase = self.CodeBase;
                if (!string.IsNullOrEmpty(codeBase))
                {
                    string dir = Path.GetDirectoryName(new Uri(codeBase).LocalPath);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                    {
                        return dir;
                    }
                }
            }
            catch { }

            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private void OnTick(object sender, EventArgs e)
        {
            // Nothing here may propagate: an exception escaping Tick can take
            // the game down with it.
            try
            {
                if (_stopped)
                {
                    return;
                }

                long now = _clock.ElapsedMilliseconds;

                if (now >= _nextOnlineCheckMs)
                {
                    _nextOnlineCheckMs = now + OnlineCheckIntervalMs;

                    if (IsOnlineSession())
                    {
                        Log.Warn("Online session detected. This plugin is story mode only — aborting.");
                        Shutdown();
                        Abort();
                        return;
                    }
                }

                Feed.Position = CaptureSnapshot(now);
            }
            catch (Exception ex)
            {
                _tickErrors++;

                if (_tickErrors <= MaxLoggedTickErrors)
                {
                    Log.Error("Tick failed.", ex);

                    if (_tickErrors == MaxLoggedTickErrors)
                    {
                        Log.Warn("Further tick errors will not be logged.");
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Everything below this line runs on the script thread ONLY.
        // ------------------------------------------------------------------

        /// <summary>
        /// The entire GTA API surface used by this plugin. Reads the world and
        /// renders it to UTF-8 JSON, so the value handed to other threads is an
        /// immutable byte array rather than anything game-owned.
        /// </summary>
        private byte[] CaptureSnapshot(long timestampMs)
        {
            Player player = Game.Player;
            Ped ped = player.Character;

            Vector3 position = ped.Position;
            float heading = ped.Heading;
            int wantedLevel = player.Wanted.WantedLevel;

            bool inVehicle = ped.IsInVehicle();
            Vehicle vehicle = inVehicle ? ped.CurrentVehicle : null;

            float speed;
            string vehicleName = null;
            string vehicleClass = null;

            if (vehicle != null)
            {
                speed = vehicle.Speed;
                vehicleName = vehicle.LocalizedName;
                vehicleClass = vehicle.ClassType.ToString();
            }
            else
            {
                speed = ped.Speed;
            }

            int gameHour = GameClock.Hour;
            int gameMinute = GameClock.Minute;

            StringBuilder sb = new StringBuilder(320);
            sb.Append("{\"x\":").Append(Json.Number(position.X));
            sb.Append(",\"y\":").Append(Json.Number(position.Y));
            sb.Append(",\"z\":").Append(Json.Number(position.Z));
            sb.Append(",\"heading\":").Append(Json.Number(heading));
            sb.Append(",\"speed\":").Append(Json.Number(speed));
            sb.Append(",\"inVehicle\":").Append(Json.Bool(inVehicle));
            sb.Append(",\"vehicleDisplayName\":").Append(Json.String(vehicleName));
            sb.Append(",\"vehicleClass\":").Append(Json.String(vehicleClass));
            sb.Append(",\"wantedLevel\":").Append(Json.Number(wantedLevel));
            sb.Append(",\"gameHour\":").Append(Json.Number(gameHour));
            sb.Append(",\"gameMinute\":").Append(Json.Number(gameMinute));
            sb.Append(",\"t\":").Append(Json.Number(timestampMs));
            sb.Append('}');

            return Encoding.UTF8.GetBytes(sb.ToString());
        }

        /// <summary>
        /// Belt and braces on top of Script Hook V, which already closes the
        /// game on entering multiplayer.
        /// </summary>
        private static bool IsOnlineSession()
        {
            // There is no NETWORK_IS_MULTIPLAYER in this API; a live network
            // session is the thing we actually care about, and these two cover
            // both an active session and one still starting up.
            return Function.Call<bool>(Hash.NETWORK_IS_SESSION_ACTIVE)
                || Function.Call<bool>(Hash.NETWORK_IS_SESSION_STARTED);
        }

        private void OnAborted(object sender, EventArgs e)
        {
            Log.Info("Aborted; shutting down.");
            Shutdown();
        }

        private void Shutdown()
        {
            _stopped = true;

            if (_server != null)
            {
                _server.Dispose();
                _server = null;
            }
        }
    }
}
