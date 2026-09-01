using System.Text;
using System.Threading;

namespace GtaLiveMap
{
    /// <summary>
    /// The hand-off between the script thread and the HTTP thread, and the
    /// single most safety-critical type here.
    ///
    /// The script thread is the ONLY thread allowed to touch the GTA API. It
    /// reads the world once per tick, renders the result to an immutable UTF-8
    /// byte array, and publishes that array with a volatile write. HTTP threads
    /// only ever take a volatile read of that reference and write the bytes to a
    /// socket — they never see a game object, so there is nothing for them to
    /// race against and no lock to contend on.
    ///
    /// Serialising on the script thread (rather than handing over a struct for
    /// the HTTP thread to format) is deliberate: it means no game-derived value
    /// can possibly be read off-thread, whatever a future change does.
    /// </summary>
    internal static class Feed
    {
        private static byte[] _position =
            Encoding.UTF8.GetBytes("{\"ok\":false,\"reason\":\"no sample yet\"}");

        /// <summary>The latest /pos payload. Safe to read from any thread.</summary>
        public static byte[] Position
        {
            get { return Volatile.Read(ref _position); }
            set { Volatile.Write(ref _position, value); }
        }
    }
}
