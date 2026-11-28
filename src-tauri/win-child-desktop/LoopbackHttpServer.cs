using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace QianjiWinDesktop
{
    internal static class MiniJson
    {
        internal static string Serialize(object value)
        {
            var sb = new StringBuilder(256);
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object value)
        {
            if (value == null) { sb.Append("null"); return; }
            string str = value as string;
            if (str != null) { WriteString(sb, str); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }
            var dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (var kv in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    WriteValue(sb, kv.Value);
                }
                sb.Append('}');
                return;
            }
            var enumerable = value as IEnumerable;
            if (enumerable != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in enumerable)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item);
                }
                sb.Append(']');
                return;
            }
            if (value is int || value is long || value is uint || value is ulong || value is short || value is byte || value is double || value is float)
            {
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }
            WriteString(sb, value.ToString());
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
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
                        if (c < 0x20) sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        internal static Dictionary<string, object> ParseObject(string json)
        {
            if (string.IsNullOrEmpty(json)) return new Dictionary<string, object>(StringComparer.Ordinal);
            int idx = 0;
            object parsed = ParseElement(json, ref idx);
            return (parsed as Dictionary<string, object>) ?? new Dictionary<string, object>(StringComparer.Ordinal);
        }

        private static void SkipWs(string s, ref int idx)
        {
            while (idx < s.Length && char.IsWhiteSpace(s[idx])) idx++;
        }

        private static object ParseElement(string s, ref int idx)
        {
            SkipWs(s, ref idx);
            if (idx >= s.Length) return null;
            char c = s[idx];
            if (c == '{')
            {
                idx++;
                var map = new Dictionary<string, object>(StringComparer.Ordinal);
                SkipWs(s, ref idx);
                if (idx < s.Length && s[idx] == '}') { idx++; return map; }
                while (idx < s.Length)
                {
                    SkipWs(s, ref idx);
                    string key = ParseString(s, ref idx);
                    SkipWs(s, ref idx);
                    if (idx < s.Length && s[idx] == ':') idx++;
                    object val = ParseElement(s, ref idx);
                    if (key != null) map[key] = val;
                    SkipWs(s, ref idx);
                    if (idx < s.Length && s[idx] == ',') { idx++; continue; }
                    if (idx < s.Length && s[idx] == '}') { idx++; break; }
                    break;
                }
                return map;
            }
            if (c == '[')
            {
                idx++;
                var list = new List<object>();
                SkipWs(s, ref idx);
                if (idx < s.Length && s[idx] == ']') { idx++; return list; }
                while (idx < s.Length)
                {
                    list.Add(ParseElement(s, ref idx));
                    SkipWs(s, ref idx);
                    if (idx < s.Length && s[idx] == ',') { idx++; continue; }
                    if (idx < s.Length && s[idx] == ']') { idx++; break; }
                    break;
                }
                return list;
            }
            if (c == '"') return ParseString(s, ref idx);
            if (idx + 4 <= s.Length && string.CompareOrdinal(s, idx, "true", 0, 4) == 0) { idx += 4; return true; }
            if (idx + 5 <= s.Length && string.CompareOrdinal(s, idx, "false", 0, 5) == 0) { idx += 5; return false; }
            if (idx + 4 <= s.Length && string.CompareOrdinal(s, idx, "null", 0, 4) == 0) { idx += 4; return null; }

            int start = idx;
            while (idx < s.Length && "-+0123456789.eE".IndexOf(s[idx]) >= 0) idx++;
            string rawNum = s.Substring(start, idx - start);
            long lval;
            if (long.TryParse(rawNum, NumberStyles.Integer, CultureInfo.InvariantCulture, out lval)) return lval;
            double dval;
            if (double.TryParse(rawNum, NumberStyles.Float, CultureInfo.InvariantCulture, out dval)) return dval;
            return null;
        }

        private static string ParseString(string s, ref int idx)
        {
            if (idx >= s.Length || s[idx] != '"') return null;
            idx++;
            var sb = new StringBuilder();
            while (idx < s.Length)
            {
                char c = s[idx++];
                if (c == '"') return sb.ToString();
                if (c == '\\' && idx < s.Length)
                {
                    char esc = s[idx++];
                    switch (esc)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (idx + 4 <= s.Length)
                            {
                                int code;
                                if (int.TryParse(s.Substring(idx, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                                    sb.Append((char)code);
                                idx += 4;
                            }
                            break;
                        default: sb.Append(esc); break;
                    }
                }
                else sb.Append(c);
            }
            return sb.ToString();
        }

        internal static string GetString(Dictionary<string, object> obj, string key, string fallback)
        {
            object v;
            if (obj != null && obj.TryGetValue(key, out v) && v != null) return v.ToString();
            return fallback;
        }

        internal static int GetInt(Dictionary<string, object> obj, string key, int fallback)
        {
            object v;
            if (obj == null || !obj.TryGetValue(key, out v) || v == null) return fallback;
            if (v is long) return (int)(long)v;
            if (v is int) return (int)v;
            if (v is double) return (int)Math.Round((double)v);
            int parsed;
            return int.TryParse(v.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
        }

        internal static bool GetBool(Dictionary<string, object> obj, string key, bool fallback)
        {
            object v;
            if (obj == null || !obj.TryGetValue(key, out v) || v == null) return fallback;
            if (v is bool) return (bool)v;
            return string.Equals(v.ToString(), "true", StringComparison.OrdinalIgnoreCase);
        }

        internal static List<string> GetStringList(Dictionary<string, object> obj, string key)
        {
            var result = new List<string>();
            object v;
            if (obj == null || !obj.TryGetValue(key, out v) || v == null) return result;
            var list = v as List<object>;
            if (list != null)
            {
                for (int i = 0; i < list.Count; i++)
                    if (list[i] != null) result.Add(list[i].ToString());
            }
            return result;
        }

        internal static List<int> GetIntList(Dictionary<string, object> obj, string key)
        {
            var result = new List<int>();
            object v;
            if (obj == null || !obj.TryGetValue(key, out v) || v == null) return result;
            var list = v as List<object>;
            if (list != null)
            {
                for (int i = 0; i < list.Count; i++)
                {
                    if (list[i] is long) result.Add((int)(long)list[i]);
                    else if (list[i] is int) result.Add((int)list[i]);
                }
            }
            return result;
        }
    }

    internal sealed class LoopbackHttpServer : IDisposable
    {
        internal const string HeaderKeyName = "X-Qianji-Key";
        private readonly TcpListener listener;
        private readonly string authKey;
        private readonly Func<string, string, Dictionary<string, object>, Dictionary<string, object>> handler;
        private volatile bool stopped;

        internal int Port { get; private set; }

        internal LoopbackHttpServer(
            int requestedPort,
            string key,
            Func<string, string, Dictionary<string, object>, Dictionary<string, object>> requestHandler)
        {
            authKey = key ?? string.Empty;
            handler = requestHandler;
            listener = new TcpListener(IPAddress.Loopback, requestedPort);
            listener.Start();
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "QianjiLoopbackHttp" };
            acceptThread.Start();
        }

        private void AcceptLoop()
        {
            while (!stopped)
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                catch
                {
                    if (stopped) break;
                }
            }
        }

        private void HandleClient(object state)
        {
            var client = (TcpClient)state;
            try
            {
                client.ReceiveTimeout = 8000;
                client.SendTimeout = 8000;
                using (NetworkStream stream = client.GetStream())
                {
                    string method, path, headerAuth;
                    int contentLength;
                    byte[] bodyBytes;
                    if (!ReadHttpRequest(stream, out method, out path, out headerAuth, out contentLength, out bodyBytes))
                        return;

                    if (!string.IsNullOrEmpty(authKey) && !ConstantTimeEquals(authKey, headerAuth ?? string.Empty))
                    {
                        var unauth = new Dictionary<string, object> { { "ok", false }, { "error", "Unauthorized" } };
                        WriteHttpResponse(stream, 401, MiniJson.Serialize(unauth));
                        return;
                    }

                    string bodyStr = (bodyBytes != null && bodyBytes.Length > 0)
                        ? Encoding.UTF8.GetString(bodyBytes)
                        : string.Empty;
                    var reqJson = MiniJson.ParseObject(bodyStr);
                    Dictionary<string, object> resp;
                    int statusCode = 200;
                    try
                    {
                        resp = handler(method, path, reqJson);
                    }
                    catch (Exception ex)
                    {
                        statusCode = 500;
                        resp = new Dictionary<string, object>
                        {
                            { "ok", false },
                            { "error", ex.GetBaseException().Message }
                        };
                    }
                    WriteHttpResponse(stream, statusCode, MiniJson.Serialize(resp));
                }
            }
            catch { }
            finally
            {
                try { client.Close(); } catch { }
            }
        }

        private static bool ConstantTimeEquals(string a, string b)
        {
            if (a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        private static bool ReadHttpRequest(
            NetworkStream stream,
            out string method,
            out string path,
            out string headerAuth,
            out int contentLength,
            out byte[] body)
        {
            method = null; path = null; headerAuth = null; contentLength = 0; body = null;
            var headerBuf = new MemoryStream();
            int prev3 = -1, prev2 = -1, prev1 = -1;
            while (headerBuf.Length < 16384)
            {
                int b = stream.ReadByte();
                if (b < 0) return false;
                headerBuf.WriteByte((byte)b);
                if (prev3 == '\r' && prev2 == '\n' && prev1 == '\r' && b == '\n') break;
                prev3 = prev2; prev2 = prev1; prev1 = b;
            }
            string rawHeaders = Encoding.ASCII.GetString(headerBuf.ToArray());
            string[] lines = rawHeaders.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries);
            if (lines.Length == 0) return false;
            string[] firstParts = lines[0].Split(' ');
            if (firstParts.Length < 2) return false;
            method = firstParts[0].Trim().ToUpperInvariant();
            path = firstParts[1].Trim();
            int qIdx = path.IndexOf('?');
            if (qIdx >= 0) path = path.Substring(0, qIdx);

            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0) continue;
                string hName = lines[i].Substring(0, colon).Trim();
                string hVal = lines[i].Substring(colon + 1).Trim();
                if (string.Equals(hName, "Content-Length", StringComparison.OrdinalIgnoreCase))
                    int.TryParse(hVal, NumberStyles.Integer, CultureInfo.InvariantCulture, out contentLength);
                else if (string.Equals(hName, HeaderKeyName, StringComparison.OrdinalIgnoreCase))
                    headerAuth = hVal;
            }

            if (contentLength > 0 && contentLength <= 8 * 1024 * 1024)
            {
                body = new byte[contentLength];
                int offset = 0;
                while (offset < contentLength)
                {
                    int n = stream.Read(body, offset, contentLength - offset);
                    if (n <= 0) break;
                    offset += n;
                }
            }
            return true;
        }

        private static void WriteHttpResponse(NetworkStream stream, int statusCode, string jsonBody)
        {
            byte[] payload = Encoding.UTF8.GetBytes(jsonBody ?? "{}");
            string statusText = statusCode == 200 ? "OK" : (statusCode == 401 ? "Unauthorized" : "Internal Server Error");
            string header = "HTTP/1.1 " + statusCode + " " + statusText + "\r\n" +
                            "Content-Type: application/json; charset=utf-8\r\n" +
                            "Content-Length: " + payload.Length.ToString(CultureInfo.InvariantCulture) + "\r\n" +
                            "Connection: close\r\n\r\n";
            byte[] headerBytes = Encoding.ASCII.GetBytes(header);
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }

        internal static Dictionary<string, object> SendJson(int port, string key, string method, string path, string jsonBody, int timeoutMs)
        {
            using (var client = new TcpClient())
            {
                IAsyncResult ar = client.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(timeoutMs))
                    throw new TimeoutException("Loopback connect timeout");
                client.EndConnect(ar);
                client.ReceiveTimeout = timeoutMs;
                client.SendTimeout = timeoutMs;
                using (NetworkStream stream = client.GetStream())
                {
                    byte[] bodyBytes = string.IsNullOrEmpty(jsonBody) ? new byte[0] : Encoding.UTF8.GetBytes(jsonBody);
                    string req = method + " " + path + " HTTP/1.1\r\n" +
                                 "Host: 127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "\r\n" +
                                 HeaderKeyName + ": " + (key ?? string.Empty) + "\r\n" +
                                 "Content-Type: application/json; charset=utf-8\r\n" +
                                 "Content-Length: " + bodyBytes.Length.ToString(CultureInfo.InvariantCulture) + "\r\n" +
                                 "Connection: close\r\n\r\n";
                    byte[] reqHeader = Encoding.ASCII.GetBytes(req);
                    stream.Write(reqHeader, 0, reqHeader.Length);
                    if (bodyBytes.Length > 0) stream.Write(bodyBytes, 0, bodyBytes.Length);
                    stream.Flush();

                    using (var ms = new MemoryStream())
                    {
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = stream.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
                        string raw = Encoding.UTF8.GetString(ms.ToArray());
                        int sep = raw.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                        string respBody = sep >= 0 ? raw.Substring(sep + 4) : raw;
                        return MiniJson.ParseObject(respBody);
                    }
                }
            }
        }

        internal static void WriteEndpointFile(string filePath, Dictionary<string, object> data)
        {
            try
            {
                string dir = Path.GetDirectoryName(filePath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                string tmp = filePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllText(tmp, MiniJson.Serialize(data), new UTF8Encoding(false));
                if (File.Exists(filePath)) File.Delete(filePath);
                File.Move(tmp, filePath);
            }
            catch (Exception ex)
            {
                Program.Log("Could not write endpoint file " + filePath + ": " + ex.GetBaseException().Message);
            }
        }

        public void Dispose()
        {
            stopped = true;
            try { listener.Stop(); } catch { }
        }
    }
}
