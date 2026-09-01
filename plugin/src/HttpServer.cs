using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace GtaLiveMap
{
    /// <summary>
    /// Serves the position feed and the static web client on a background
    /// thread. Touches no GTA API whatsoever — see <see cref="Feed"/>.
    /// </summary>
    internal sealed class HttpServer : IDisposable
    {
        private byte[] _healthBody = Encoding.UTF8.GetBytes("{\"ok\":true}");

        private static readonly Dictionary<string, string> MimeTypes =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { ".html", "text/html; charset=utf-8" },
                { ".js",   "text/javascript; charset=utf-8" },
                { ".css",  "text/css; charset=utf-8" },
                { ".json", "application/json; charset=utf-8" },
                { ".txt",  "text/plain; charset=utf-8" },
                { ".svg",  "image/svg+xml" },
                { ".png",  "image/png" },
                { ".jpg",  "image/jpeg" },
                { ".jpeg", "image/jpeg" },
                { ".webp", "image/webp" },
                { ".gif",  "image/gif" },
                { ".ico",  "image/x-icon" }
            };

        private readonly int _port;
        private readonly bool _bindAll;
        private readonly string _webRoot;
        private readonly string _baseDirectory;
        private readonly string _webRootAttempted;

        private HttpListener _listener;
        private Thread _thread;
        private volatile bool _running;

        public HttpServer(Config cfg, string baseDirectory)
        {
            _port = cfg.Port;
            _bindAll = cfg.BindAllInterfaces;

            string root = cfg.WebRoot;
            if (!Path.IsPathRooted(root))
            {
                root = Path.Combine(baseDirectory, root);
            }

            _baseDirectory = baseDirectory;
            _webRootAttempted = root;
            _webRoot = Directory.Exists(root) ? Path.GetFullPath(root) : null;

            if (_webRoot == null)
            {
                Log.Warn("Web root '" + root + "' does not exist; / will return 404. " +
                         "Copy the repo's web/ folder there to serve the client from the game.");
            }
        }

        public string BoundPrefix { get; private set; }

        public void Start()
        {
            if (_bindAll && TryBind("+"))
            {
                // Reachable from other devices on the LAN.
            }
            else if (!TryBind("localhost"))
            {
                Log.Error("Could not bind to any address; the feed will not be available.", null);
                return;
            }

            // Build the health payload now that the bound address is known. It
            // carries the resolved paths deliberately: if the plugin ever fails
            // to find its own folder again, /health says so even though that
            // same failure is what stops the log file appearing.
            StringBuilder health = new StringBuilder(256);
            health.Append("{\"ok\":true,\"boundPrefix\":").Append(Json.String(BoundPrefix));
            health.Append(",\"baseDirectory\":").Append(Json.String(_baseDirectory));
            health.Append(",\"appDomainBase\":").Append(Json.String(AppDomain.CurrentDomain.BaseDirectory));
            health.Append(",\"webRoot\":").Append(Json.String(_webRoot));
            health.Append(",\"webRootAttempted\":").Append(Json.String(_webRootAttempted));
            health.Append(",\"servingStaticFiles\":").Append(Json.Bool(_webRoot != null));
            health.Append('}');
            _healthBody = Encoding.UTF8.GetBytes(health.ToString());

            _running = true;
            _thread = new Thread(Loop);
            _thread.IsBackground = true;
            _thread.Name = "LiveMap HTTP";
            _thread.Start();

            Log.Info("Listening on " + BoundPrefix);
        }

        private bool TryBind(string host)
        {
            string prefix = "http://" + host + ":" + _port.ToString(CultureInfo.InvariantCulture) + "/";
            HttpListener listener = new HttpListener();

            try
            {
                listener.Prefixes.Add(prefix);
                listener.Start();
                _listener = listener;
                BoundPrefix = prefix;
                return true;
            }
            catch (HttpListenerException ex)
            {
                try { listener.Close(); } catch { }

                if (host == "+")
                {
                    // Error 5 is access denied: binding a wildcard prefix needs
                    // either administrator rights or a one-off URL reservation.
                    Log.Warn("Could not bind " + prefix + " (" + ex.Message + ", code " + ex.ErrorCode + ").");
                    Log.Warn("Falling back to localhost, so OTHER DEVICES ON YOUR NETWORK WILL NOT REACH IT.");
                    Log.Warn("To allow LAN access, run this once in an admin command prompt:");
                    Log.Warn("    netsh http add urlacl url=http://+:" +
                             _port.ToString(CultureInfo.InvariantCulture) + "/ user=%USERDOMAIN%\\%USERNAME%");
                    Log.Warn("...and allow the port through the firewall:");
                    Log.Warn("    netsh advfirewall firewall add rule name=\"GTA V Live Map\" " +
                             "dir=in action=allow protocol=TCP localport=" +
                             _port.ToString(CultureInfo.InvariantCulture));
                }
                else
                {
                    Log.Error("Could not bind " + prefix + " either. Is the port already in use?", ex);
                }

                return false;
            }
            catch (Exception ex)
            {
                try { listener.Close(); } catch { }
                Log.Error("Unexpected failure binding " + prefix + ".", ex);
                return false;
            }
        }

        private void Loop()
        {
            while (_running)
            {
                HttpListenerContext context;

                try
                {
                    context = _listener.GetContext();
                }
                catch (HttpListenerException)
                {
                    break;      // listener stopped
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Log.Error("Accept failed.", ex);
                    continue;
                }

                // Handle off the accept loop so a static file read cannot delay
                // the next /pos poll.
                ThreadPool.QueueUserWorkItem(HandleContext, context);
            }
        }

        private void HandleContext(object state)
        {
            HttpListenerContext context = (HttpListenerContext)state;

            try
            {
                Handle(context);
            }
            catch (Exception ex)
            {
                Log.Error("Request failed.", ex);
                try { context.Response.StatusCode = 500; } catch { }
            }
            finally
            {
                try { context.Response.OutputStream.Close(); } catch { }
            }
        }

        private void Handle(HttpListenerContext context)
        {
            HttpListenerRequest request = context.Request;
            HttpListenerResponse response = context.Response;

            response.AddHeader("Access-Control-Allow-Origin", "*");
            response.AddHeader("Cache-Control", "no-store");

            if (request.HttpMethod == "OPTIONS")
            {
                response.AddHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
                response.StatusCode = 204;
                return;
            }

            if (request.HttpMethod != "GET" && request.HttpMethod != "HEAD")
            {
                response.StatusCode = 405;
                return;
            }

            string path = request.Url.AbsolutePath;

            if (path == "/pos")
            {
                Send(response, 200, "application/json; charset=utf-8", Feed.Position);
                return;
            }

            if (path == "/health")
            {
                Send(response, 200, "application/json; charset=utf-8", _healthBody);
                return;
            }

            ServeStatic(response, path);
        }

        private void ServeStatic(HttpListenerResponse response, string path)
        {
            if (_webRoot == null)
            {
                SendText(response, 404, "No web root configured.");
                return;
            }

            string relative;
            try
            {
                relative = Uri.UnescapeDataString(path).TrimStart('/');
            }
            catch
            {
                SendText(response, 400, "Bad path.");
                return;
            }

            if (relative.Length == 0)
            {
                relative = "index.html";
            }

            string full;
            try
            {
                full = Path.GetFullPath(Path.Combine(_webRoot, relative));
            }
            catch
            {
                SendText(response, 400, "Bad path.");
                return;
            }

            // Containment: compare against the root plus a separator, so a
            // sibling directory cannot satisfy a bare prefix test.
            string rootPrefix = _webRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                SendText(response, 404, "Not found.");
                return;
            }

            string extension = Path.GetExtension(full);
            string mime;
            if (!MimeTypes.TryGetValue(extension, out mime))
            {
                mime = "application/octet-stream";
            }

            try
            {
                Send(response, 200, mime, File.ReadAllBytes(full));
            }
            catch (Exception ex)
            {
                Log.Error("Could not read " + full + ".", ex);
                SendText(response, 500, "Read error.");
            }
        }

        private static void Send(HttpListenerResponse response, int status, string contentType, byte[] body)
        {
            response.StatusCode = status;
            response.ContentType = contentType;
            response.ContentLength64 = body.Length;
            response.OutputStream.Write(body, 0, body.Length);
        }

        private static void SendText(HttpListenerResponse response, int status, string message)
        {
            Send(response, status, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(message));
        }

        public void Dispose()
        {
            _running = false;

            try
            {
                if (_listener != null)
                {
                    _listener.Stop();
                    _listener.Close();
                }
            }
            catch (Exception ex)
            {
                Log.Error("Error shutting the listener down.", ex);
            }

            _listener = null;
        }
    }
}
