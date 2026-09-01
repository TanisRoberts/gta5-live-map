using System;
using System.Globalization;
using System.Text;

namespace GtaLiveMap
{
    /// <summary>
    /// Minimal JSON emitters. Hand-rolled to keep the plugin dependency-free.
    ///
    /// Everything formats with InvariantCulture on purpose: on a machine with a
    /// comma decimal separator, the default would emit 1,5 and produce JSON the
    /// client cannot parse.
    /// </summary>
    internal static class Json
    {
        public static string Number(float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                return "0";
            }

            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        public static string Number(int value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        public static string Number(long value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        public static string Bool(bool value)
        {
            return value ? "true" : "false";
        }

        /// <summary>Quoted, escaped string, or a bare null for a null input.</summary>
        public static string String(string value)
        {
            if (value == null)
            {
                return "null";
            }

            StringBuilder sb = new StringBuilder(value.Length + 2);
            sb.Append('"');

            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }

            sb.Append('"');
            return sb.ToString();
        }
    }
}
