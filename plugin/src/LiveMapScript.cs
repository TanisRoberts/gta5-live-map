using System;
using System.Collections.Generic;
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

        /// <summary>
        /// How often to look up the street and district. These are spatial
        /// queries and the answer changes far more slowly than the position, so
        /// there is no reason to pay for them on every tick.
        /// </summary>
        private const long PlaceCheckIntervalMs = 250;

        /// <summary>
        /// Burst tyres mean walking every wheel on the vehicle. That is far
        /// too much to pay 20 times a second for a value that changes on the
        /// scale of a gunfight, so it rides the same kind of throttle as the
        /// street lookup.
        /// </summary>
        private const long DamageCheckIntervalMs = 250;

        private readonly Stopwatch _clock = Stopwatch.StartNew();

        private HttpServer _server;
        private long _nextOnlineCheckMs;
        private int _tickErrors;
        private bool _stopped;

        // Cached between place lookups.
        private long _nextPlaceCheckMs;
        private string _streetName;
        private string _crossingStreet;
        private string _zoneName;

        // Cached between damage lookups.
        private long _nextDamageCheckMs;
        private int _tyresBurst;
        private string _wheelStates;
        private string _doorStates;

        // Resolved only when the player ped changes, which is once per
        // character switch rather than twenty times a second.
        private int _lastPedModel;
        private string _character;
        private string _characterColor;

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
            // (%LOCALAPPDATA%\assembly\dl3\...), so Assembly.Location points at
            // a real directory that is emphatically NOT where we were deployed —
            // no ini, no web root, and a log nobody will ever find.
            //
            // Measured on SHVDN Enhanced v1.1.0.6: the script AppDomain's base
            // directory IS the scripts folder itself, not the game root. Rather
            // than bet on any one host's layout, gather the candidates and pick
            // whichever actually contains our deployed DLL.
            List<string> candidates = new List<string>();

            string appBase = SafeAppDomainBase();
            candidates.Add(appBase);
            if (!string.IsNullOrEmpty(appBase))
            {
                candidates.Add(SafeCombine(appBase, "scripts"));
            }

            Assembly self = Assembly.GetExecutingAssembly();
            candidates.Add(SafeDirectoryOf(SafeLocation(self)));
            candidates.Add(SafeDirectoryOf(SafeCodeBasePath(self)));

            foreach (string candidate in candidates)
            {
                if (LooksLikeOurFolder(candidate))
                {
                    return candidate;
                }
            }

            // Nothing held the DLL (renamed on deploy?). Settle for anything real.
            foreach (string candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate) && SafeDirectoryExists(candidate))
                {
                    return candidate;
                }
            }

            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private static bool LooksLikeOurFolder(string directory)
        {
            if (string.IsNullOrEmpty(directory) || !SafeDirectoryExists(directory))
            {
                return false;
            }

            try
            {
                return File.Exists(Path.Combine(directory, "LiveMap.dll"));
            }
            catch
            {
                return false;
            }
        }

        private static bool SafeDirectoryExists(string path)
        {
            try { return Directory.Exists(path); } catch { return false; }
        }

        private static string SafeAppDomainBase()
        {
            try { return AppDomain.CurrentDomain.BaseDirectory; } catch { return null; }
        }

        private static string SafeCombine(string a, string b)
        {
            try { return Path.Combine(a, b); } catch { return null; }
        }

        private static string SafeLocation(Assembly assembly)
        {
            try { return assembly.Location; } catch { return null; }
        }

        private static string SafeCodeBasePath(Assembly assembly)
        {
            try
            {
                string codeBase = assembly.CodeBase;
                return string.IsNullOrEmpty(codeBase) ? null : new Uri(codeBase).LocalPath;
            }
            catch { return null; }
        }

        private static string SafeDirectoryOf(string filePath)
        {
            if (string.IsNullOrEmpty(filePath)) { return null; }
            try { return Path.GetDirectoryName(filePath); } catch { return null; }
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

            // Which protagonist, cached against the ped model -- see
            // ResolveCharacter for why the colour is not hard-coded.
            int pedModel = ped.Model.Hash;
            if (pedModel != _lastPedModel)
            {
                _lastPedModel = pedModel;
                ResolveCharacter(ped);
            }

            /*
             * Death and arrest, so the client can break the trail rather than
             * drawing a straight line from where you died to the hospital.
             *
             * Both are read here, at the moment they happen, because by the
             * time the position jumps the player is already alive again and
             * standing outside Pillbox with nothing left to say what occurred.
             */
            bool isDead = ped.IsDead || player.IsDead;
            bool isArrested = ped.IsCuffed
                || Function.Call<bool>(Hash.IS_PLAYER_BEING_ARRESTED, player);

            bool inVehicle = ped.IsInVehicle();
            Vehicle vehicle = inVehicle ? ped.CurrentVehicle : null;

            float speed;
            float rpm = 0f;
            float fuel = -1f;
            int gear = 0;
            string vehicleName = null;
            string vehicleClass = null;
            string vehicleColor = null;
            string licensePlate = null;
            string plateStyle = null;
            string vehicleMake = null;
            float engineHealth = 0f;
            bool onFire = false;
            int tyresBurst = 0;
            string wheelStates = null;
            string doorStates = null;
            float bodyHealth = 0f;
            float tankHealth = 0f;
            bool bumperF = false;
            bool bumperR = false;
            bool engineRunning = false;
            bool lightsOn = false;
            bool highBeams = false;
            bool headlightsGone = false;
            bool headlightL = false;
            bool headlightR = false;

            if (vehicle != null)
            {
                speed = vehicle.Speed;

                // Engine revs. Already normalised 0..1 by the game -- there is
                // no readable redline or maximum anywhere in the API, so the
                // client picks its own (0.85) for the red zone.
                rpm = vehicle.CurrentRPM;

                // Petrol remaining, so we can find out whether it actually
                // drains in story mode. -1 means "not in a vehicle".
                fuel = vehicle.FuelLevel;
                gear = vehicle.CurrentGear;

                vehicleName = vehicle.LocalizedName;
                vehicleClass = vehicle.ClassType.ToString();

                // Manufacturer. The native returns a label key ("VAPID"), so
                // it needs the text table to become "Vapid" -- and it answers
                // for models it does not know with a placeholder rather than
                // an empty string, which Clean() alone would happily pass on.
                vehicleMake = Clean(Game.GetLocalizedString(
                    Function.Call<string>(Hash.GET_MAKE_NAME_FROM_VEHICLE_MODEL,
                                          vehicle.Model.Hash)));
                if (LooksUnnamed(vehicleMake)) vehicleMake = null;

                // Raw, so the client owns the thresholds: nothing here knows
                // what counts as "damaged" better than the thing drawing it,
                // and tuning it should not need a rebuild and a reload.
                engineHealth = vehicle.EngineHealth;
                onFire = vehicle.IsOnFire;
                engineRunning = vehicle.IsEngineRunning;
                lightsOn = vehicle.AreLightsOn;
                highBeams = vehicle.AreHighBeamsOn;

                /*
                 * Headlights, per side as well as together.
                 *
                 * The "both" native is carried alongside the two individual
                 * ones deliberately: it reported damage on an undamaged car
                 * during QA, and until the three are seen to agree it is not
                 * trustworthy on its own. Per-side is also better information,
                 * since one unit out is a caution and two is a warning.
                 */
                headlightL = Function.Call<bool>(
                    Hash.GET_IS_LEFT_VEHICLE_HEADLIGHT_DAMAGED, vehicle);
                headlightR = Function.Call<bool>(
                    Hash.GET_IS_RIGHT_VEHICLE_HEADLIGHT_DAMAGED, vehicle);
                headlightsGone = Function.Call<bool>(
                    Hash.GET_BOTH_VEHICLE_HEADLIGHTS_DAMAGED, vehicle);

                /*
                 * Per-part damage, on a throttle -- see DamageCheckIntervalMs.
                 *
                 * Walking wheels and doors is far too much to pay for twenty
                 * times a second for something that changes on the scale of a
                 * crash, so it rides the same throttle the burst-tyre count has
                 * always used, and the results are cached between checks.
                 *
                 * Wheels and doors are reported as compact "position:state"
                 * lists rather than nested JSON. Only the parts the vehicle
                 * actually has appear, so a two-door reports two doors and a
                 * bike reports two wheels -- the client never has to assume a
                 * layout.
                 */
                if (timestampMs >= _nextDamageCheckMs)
                {
                    _nextDamageCheckMs = timestampMs + DamageCheckIntervalMs;
                    _tyresBurst = 0;

                    StringBuilder wsb = new StringBuilder(48);
                    VehicleWheelCollection wheels = vehicle.Wheels;
                    if (wheels != null)
                    {
                        VehicleWheel[] all = wheels.GetAllWheels();
                        if (all != null)
                        {
                            for (int i = 0; i < all.Length; i++)
                            {
                                VehicleWheel w = all[i];
                                if (w == null) continue;

                                // Punctured counts too: a flat is a flat well
                                // before the tyre leaves the rim.
                                bool flat = w.IsBursted || w.IsPunctured;
                                if (flat) _tyresBurst++;

                                string pos = WheelPosition(w.BoneId);
                                if (pos == null) continue;

                                if (wsb.Length > 0) wsb.Append(',');
                                wsb.Append(pos).Append(':').Append(flat ? '1' : '0');
                            }
                        }
                    }
                    _wheelStates = wsb.Length > 0 ? wsb.ToString() : null;

                    StringBuilder dsb = new StringBuilder(48);
                    VehicleDoorCollection doors = vehicle.Doors;
                    if (doors != null)
                    {
                        VehicleDoor[] all = doors.ToArray();
                        if (all != null)
                        {
                            for (int i = 0; i < all.Length; i++)
                            {
                                VehicleDoor d = all[i];
                                if (d == null) continue;

                                string pos = DoorPosition(d.Index);
                                if (pos == null) continue;

                                // Broken outranks open: a door on the road is
                                // not merely ajar.
                                char state = d.IsBroken ? '2' : (d.IsOpen ? '1' : '0');

                                if (dsb.Length > 0) dsb.Append(',');
                                dsb.Append(pos).Append(':').Append(state);
                            }
                        }
                    }
                    _doorStates = dsb.Length > 0 ? dsb.ToString() : null;
                }

                tyresBurst = _tyresBurst;
                wheelStates = _wheelStates;
                doorStates = _doorStates;

                bodyHealth = vehicle.BodyHealth;
                tankHealth = vehicle.PetrolTankHealth;
                bumperF = vehicle.IsFrontBumperBrokenOff;
                bumperR = vehicle.IsRearBumperBrokenOff;

                VehicleModCollection mods = vehicle.Mods;
                if (mods != null)
                {
                    // A resprayed vehicle carries an arbitrary RGB, and the enum
                    // then reports whatever it happened to land nearest — so say
                    // "Custom" rather than name a colour that is not true.
                    vehicleColor = mods.IsPrimaryColorCustom
                        ? "Custom"
                        : mods.PrimaryColor.ToString();

                    licensePlate = Clean(mods.LicensePlate);

                    // Which plate design the vehicle is actually wearing, so
                    // the client can draw that one rather than assume the
                    // default. Rockstar's own names carry the colours for the
                    // six base styles (BlueOnWhite1..3, YellowOnBlue,
                    // YellowOnBlack, NorthYankton); the rest are branded.
                    plateStyle = mods.LicensePlateStyle.ToString();
                }
            }
            else
            {
                speed = ped.Speed;
            }

            // Street and district, refreshed a few times a second rather than
            // every tick — see PlaceCheckIntervalMs.
            if (timestampMs >= _nextPlaceCheckMs)
            {
                _nextPlaceCheckMs = timestampMs + PlaceCheckIntervalMs;

                string crossing;
                _streetName = Clean(World.GetStreetName(position, out crossing));
                _crossingStreet = Clean(crossing);
                _zoneName = Clean(World.GetZoneLocalizedName(position));
            }

            int gameHour = GameClock.Hour;
            int gameMinute = GameClock.Minute;

            StringBuilder sb = new StringBuilder(320);
            sb.Append("{\"x\":").Append(Json.Number(position.X));
            sb.Append(",\"y\":").Append(Json.Number(position.Y));
            sb.Append(",\"z\":").Append(Json.Number(position.Z));
            sb.Append(",\"heading\":").Append(Json.Number(heading));
            sb.Append(",\"speed\":").Append(Json.Number(speed));
            sb.Append(",\"rpm\":").Append(Json.Number(rpm));
            sb.Append(",\"fuel\":").Append(Json.Number(fuel));
            sb.Append(",\"gear\":").Append(Json.Number(gear));
            sb.Append(",\"inVehicle\":").Append(Json.Bool(inVehicle));
            sb.Append(",\"vehicleDisplayName\":").Append(Json.String(vehicleName));
            sb.Append(",\"vehicleClass\":").Append(Json.String(vehicleClass));
            sb.Append(",\"vehicleColor\":").Append(Json.String(vehicleColor));
            sb.Append(",\"licensePlate\":").Append(Json.String(licensePlate));
            sb.Append(",\"plateStyle\":").Append(Json.String(plateStyle));
            sb.Append(",\"vehicleMake\":").Append(Json.String(vehicleMake));
            sb.Append(",\"engineHealth\":").Append(Json.Number(engineHealth));
            sb.Append(",\"onFire\":").Append(Json.Bool(onFire));
            sb.Append(",\"tyresBurst\":").Append(Json.Number(tyresBurst));
            sb.Append(",\"wheelStates\":").Append(Json.String(wheelStates));
            sb.Append(",\"doorStates\":").Append(Json.String(doorStates));
            sb.Append(",\"bodyHealth\":").Append(Json.Number(bodyHealth));
            sb.Append(",\"tankHealth\":").Append(Json.Number(tankHealth));
            sb.Append(",\"bumperF\":").Append(Json.Bool(bumperF));
            sb.Append(",\"bumperR\":").Append(Json.Bool(bumperR));
            sb.Append(",\"engineRunning\":").Append(Json.Bool(engineRunning));
            sb.Append(",\"lightsOn\":").Append(Json.Bool(lightsOn));
            sb.Append(",\"highBeams\":").Append(Json.Bool(highBeams));
            sb.Append(",\"headlightsGone\":").Append(Json.Bool(headlightsGone));
            sb.Append(",\"headlightL\":").Append(Json.Bool(headlightL));
            sb.Append(",\"headlightR\":").Append(Json.Bool(headlightR));
            sb.Append(",\"streetName\":").Append(Json.String(_streetName));
            sb.Append(",\"crossingStreet\":").Append(Json.String(_crossingStreet));
            sb.Append(",\"zoneName\":").Append(Json.String(_zoneName));
            sb.Append(",\"wantedLevel\":").Append(Json.Number(wantedLevel));
            sb.Append(",\"character\":").Append(Json.String(_character));
            sb.Append(",\"characterColor\":").Append(Json.String(_characterColor));
            sb.Append(",\"isDead\":").Append(Json.Bool(isDead));
            sb.Append(",\"isArrested\":").Append(Json.Bool(isArrested));
            sb.Append(",\"gameHour\":").Append(Json.Number(gameHour));
            sb.Append(",\"gameMinute\":").Append(Json.Number(gameMinute));
            sb.Append(",\"t\":").Append(Json.Number(timestampMs));
            sb.Append('}');

            return Encoding.UTF8.GetBytes(sb.ToString());
        }

        /// <summary>
        /// Blank game strings become null, so the JSON says "absent" rather than
        /// "" and the client has one thing to test. Number plates in particular
        /// come back padded.
        /// </summary>
        /// <summary>
        /// Works out which protagonist is being played, and the colour the game
        /// itself uses for them.
        ///
        /// The colour comes from GET_HUD_COLOUR rather than being hard-coded.
        /// Michael blue, Franklin green and Trevor orange are the game's own
        /// HUD colours, so there is no reason to approximate them -- and if a
        /// patch ever retunes them, this follows.
        ///
        /// Only called when the player ped model changes, because the four
        /// OutputArguments are not worth allocating twenty times a second for
        /// an answer that changes when you switch character.
        /// </summary>
        private void ResolveCharacter(Ped ped)
        {
            _character = null;
            _characterColor = null;

            GTA.UI.HudColor hud;
            if (ped.Model == PedHash.Michael)
            {
                _character = "Michael";
                hud = GTA.UI.HudColor.Michael;
            }
            else if (ped.Model == PedHash.Franklin || ped.Model == PedHash.Franklin02)
            {
                _character = "Franklin";
                hud = GTA.UI.HudColor.Franklin;
            }
            else if (ped.Model == PedHash.Trevor)
            {
                _character = "Trevor";
                hud = GTA.UI.HudColor.Trevor;
            }
            else
            {
                // A mission ped, or a custom skin. The client falls back to a
                // neutral avatar rather than guessing.
                return;
            }

            OutputArgument r = new OutputArgument();
            OutputArgument g = new OutputArgument();
            OutputArgument b = new OutputArgument();
            OutputArgument a = new OutputArgument();
            Function.Call(Hash.GET_HUD_COLOUR, (int)hud, r, g, b, a);

            _characterColor = "#"
                + Clamp255(r.GetResult<int>()).ToString("x2")
                + Clamp255(g.GetResult<int>()).ToString("x2")
                + Clamp255(b.GetResult<int>()).ToString("x2");
        }

        private static int Clamp255(int v)
        {
            return v < 0 ? 0 : (v > 255 ? 255 : v);
        }

        /// <summary>
        /// Short position codes for a wheel, so the client can put a flat on
        /// the right corner. Anything with no meaningful position -- a spare,
        /// or an unmapped bone -- is skipped rather than guessed at.
        /// </summary>
        private static string WheelPosition(VehicleWheelBoneId bone)
        {
            switch (bone)
            {
                case VehicleWheelBoneId.WheelLeftFront:    return "lf";
                case VehicleWheelBoneId.WheelRightFront:   return "rf";
                case VehicleWheelBoneId.WheelLeftRear:     return "lr";
                case VehicleWheelBoneId.WheelRightRear:    return "rr";
                case VehicleWheelBoneId.WheelLeftMiddle1:  return "lm1";
                case VehicleWheelBoneId.WheelRightMiddle1: return "rm1";
                case VehicleWheelBoneId.WheelLeftMiddle2:  return "lm2";
                case VehicleWheelBoneId.WheelRightMiddle2: return "rm2";
                case VehicleWheelBoneId.WheelLeftMiddle3:  return "lm3";
                case VehicleWheelBoneId.WheelRightMiddle3: return "rm3";
                default: return null;
            }
        }

        /// <summary>
        /// Short position codes for a door, on the same principle.
        /// </summary>
        private static string DoorPosition(VehicleDoorIndex door)
        {
            switch (door)
            {
                case VehicleDoorIndex.FrontLeftDoor:  return "fl";
                case VehicleDoorIndex.FrontRightDoor: return "fr";
                case VehicleDoorIndex.BackLeftDoor:   return "bl";
                case VehicleDoorIndex.BackRightDoor:  return "br";
                case VehicleDoorIndex.Hood:           return "hood";
                case VehicleDoorIndex.Trunk:          return "boot";
                default: return null;
            }
        }

        private static string Clean(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            return value.Trim();
        }

        /// <summary>
        /// The make native answers for a model it does not know with a
        /// placeholder rather than with nothing, and the text table answers for
        /// a key it does not hold with "NULL". Either would otherwise reach the
        /// client looking like a manufacturer's name.
        /// </summary>
        private static bool LooksUnnamed(string value)
        {
            if (value == null) return true;
            return value.Equals("NULL", StringComparison.OrdinalIgnoreCase)
                || value.Equals("CARNOTFOUND", StringComparison.OrdinalIgnoreCase);
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
