package lxs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type netConn = net.Conn

const maxProxyBody = 64 * 1024

var hopByHop = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"upgrade":             true,
}

// Credentials of real users never reach the attacker-facing container.
var strippedRequest = map[string]bool{"cookie": true, "authorization": true, "proxy-authorization": true}

// decoySessionCookie returns "PHPSESSID=<v>" for the first PHPSESSID cookie in ds-web's exact
// format (26 chars of [0-9a-v]), the only cookie that is forwarded to the decoy.
func decoySessionCookie(lines []string) string {
	text := strings.Join(lines, "; ")
	if text == "" || len(text) > 8192 {
		return ""
	}
	for _, part := range strings.Split(text, ";") {
		eq := strings.IndexByte(part, '=')
		if eq < 0 || strings.TrimFunc(part[:eq], isJSSpace) != "PHPSESSID" {
			continue
		}
		v := strings.TrimFunc(part[eq+1:], isJSSpace)
		if validSID(v) {
			return "PHPSESSID=" + v
		}
	}
	return ""
}

func validSID(v string) bool {
	if len(v) != 26 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'v') {
			return false
		}
	}
	return true
}

// requestID is base-36 milliseconds plus 12 hex characters, like the Node SDK's.
func requestID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return strconv.FormatInt(time.Now().UnixMilli(), 36) + hex.EncodeToString(b[:])
}

var errBodyTooLarge = errors.New("lxs: decoy request body over 64 KiB")

// limitedBody fails once more than maxProxyBody bytes have been read.
type limitedBody struct {
	r        io.ReadCloser
	n        int
	exceeded bool
}

func (l *limitedBody) Read(p []byte) (int, error) {
	if l.exceeded {
		return 0, errBodyTooLarge
	}
	n, err := l.r.Read(p)
	l.n += n
	if l.n > maxProxyBody {
		l.exceeded = true
		return 0, errBodyTooLarge
	}
	return n, err
}

func (l *limitedBody) Close() error { return l.r.Close() }

// proxy sends the request to ds-web over the web socket and relays the answer. It never falls
// back to the app: unreachable gives 404, a slow decoy 504, an oversized body 413.
func (m *Middleware) proxy(w http.ResponseWriter, r *http.Request, d *decoyMatch, ip, target string) {
	if r.ContentLength > maxProxyBody {
		writePlain(w, http.StatusRequestEntityTooLarge, "Payload Too Large")
		return
	}
	h := make(http.Header, len(r.Header)+3)
	for k, vv := range r.Header {
		lk := strings.ToLower(k)
		if hopByHop[lk] || strippedRequest[lk] || hasDSPrefix(k) {
			continue
		}
		h[k] = append([]string(nil), vv...)
	}
	if sid := decoySessionCookie(r.Header.Values("Cookie")); sid != "" {
		h["Cookie"] = []string{sid}
	}
	h["X-Ds-Client-Ip"] = []string{ip}
	h["X-Ds-Decoy-Id"] = []string{d.id}
	h["X-Ds-Request-Id"] = []string{requestID()}
	if _, ok := h["User-Agent"]; !ok {
		h["User-Agent"] = []string{""} // do not let net/http add its own
	}

	var body io.ReadCloser = http.NoBody
	var lim *limitedBody
	if r.Body != nil && r.Body != http.NoBody && (r.ContentLength > 0 || r.ContentLength < 0) {
		lim = &limitedBody{r: r.Body}
		body = lim
	}
	out := &http.Request{
		Method:        r.Method,
		URL:           &url.URL{Scheme: "http", Host: "ds-web", Opaque: target},
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        h,
		Body:          body,
		ContentLength: r.ContentLength,
		Host:          r.Host,
	}
	if r.ContentLength < 0 {
		out.ContentLength = -1
	}
	out = out.WithContext(r.Context())

	resp, err := m.web.RoundTrip(out)
	if lim != nil && lim.exceeded {
		if resp != nil {
			resp.Body.Close()
		}
		writePlain(w, http.StatusRequestEntityTooLarge, "Payload Too Large")
		return
	}
	if err != nil {
		m.errors.Add(1)
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			writePlain(w, http.StatusGatewayTimeout, "Gateway Timeout")
			return
		}
		m.warnOnce("decoy", "decoy socket unreachable; serving a generic 404 for decoy paths.")
		writePlain(w, http.StatusNotFound, "Not Found")
		return
	}
	defer resp.Body.Close()
	wh := w.Header()
	for k, vv := range resp.Header {
		lk := strings.ToLower(k)
		if hopByHop[lk] || lk == "transfer-encoding" {
			continue
		}
		wh[k] = vv
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
