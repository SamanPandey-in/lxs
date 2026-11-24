package lxs_test

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
	"github.com/SamanPandey-in/lxs/sdk/go/lxstest"
)

func start(t *testing.T, cfg lxs.Config, opts lxstest.Options) (*lxs.Middleware, *lxstest.FakeAgent) {
	t.Helper()
	dir := t.TempDir()
	opts.RunDir = dir
	opts.FakeDecoy = true
	agent, err := lxstest.StartFakeAgent(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { agent.Close() })
	cfg.RunDir = dir
	cfg.PollInterval = 50 * time.Millisecond
	cfg.FlushInterval = 20 * time.Millisecond
	m, err := lxs.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	deadline := time.Now().Add(3 * time.Second)
	for !m.Stats().PolicyLoaded {
		if time.Now().After(deadline) {
			t.Fatal("policy never loaded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return m, agent
}

var appHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	_, _ = io.WriteString(w, "app")
})

func do(h http.Handler, method, target, remote string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	r.RequestURI = target
	r.RemoteAddr = remote
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestConfigErrors(t *testing.T) {
	cases := []struct {
		cfg  lxs.Config
		code string
		msg  string
	}{
		{lxs.Config{TrustProxy: true}, "E_TRUST_PROXY", "E_TRUST_PROXY: trustProxy: true is not supported: it makes the leftmost X-Forwarded-For entry the client address, and the client controls that entry, so any attacker could pick their own IP (evading blocks, or getting someone else blocked). Use a hop count (trustProxy: 1 for one reverse proxy in front of the app) or list your proxies' addresses (trustProxy: ['loopback'] or ['10.0.0.0/8'])."},
		{lxs.Config{Allowlist: []string{"0.0.0.0/0"}}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: allowlist.0 '0.0.0.0/0' matches every address and would disable blocking entirely; list your own scanners' ranges instead."},
		{lxs.Config{Allowlist: []string{"bogus", "::/0"}}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: allowlist.0 invalid CIDR 'bogus'; allowlist.1 '::/0' matches every address and would disable blocking entirely; list your own scanners' ranges instead."},
		{lxs.Config{TrustProxy: []string{"0.0.0.0/0"}}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: trustProxy.0 '0.0.0.0/0' trusts every address, which lets any client forge X-Forwarded-For; list your proxies' addresses instead."},
		{lxs.Config{TrustProxy: []string{"nope"}}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: trustProxy.0 invalid trustProxy entry 'nope'."},
		{lxs.Config{TrustProxy: 0}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: trustProxy trustProxy hop count must be at least 1 (use false for no proxy)."},
		{lxs.Config{TrustProxy: 11}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: trustProxy trustProxy hop count must be at most 10."},
		{lxs.Config{TrustProxy: 1.5}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: trustProxy Invalid input."},
		{lxs.Config{TrustProxy: "x"}, "E_OPTIONS", "E_OPTIONS: invalid LXS options: trustProxy Invalid input."},
		{lxs.Config{Mode: "x"}, "E_OPTIONS", `E_OPTIONS: invalid LXS options: mode Invalid option: expected one of "monitor"|"enforce".`},
		{lxs.Config{Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/"}}}, "E_MOUNT_RESERVED", ""},
		{lxs.Config{Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/a//b"}}}, "E_MOUNT_INVALID", ""},
		{lxs.Config{Decoys: []lxs.Decoy{{Type: "web-bait", Path: "/x"}}}, "E_TEMPLATE_UNKNOWN", ""},
		{lxs.Config{Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/a"}, {Type: "web-bait", Path: "/a", Template: "dotenv"}}}, "E_MOUNT_COLLISION", ""},
		{lxs.Config{Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/a", ID: "x"}, {Type: "web-admin", Path: "/b", ID: "x"}}}, "E_ID_COLLISION", ""},
	}
	for _, c := range cases {
		c.cfg.Disabled = true
		_, err := lxs.New(c.cfg)
		var ce *lxs.ConfigError
		if !errors.As(err, &ce) || ce.Code != c.code {
			t.Errorf("%+v: got %v, want %s", c.cfg, err, c.code)
			continue
		}
		if c.msg != "" && err.Error() != c.msg {
			t.Errorf("message:\n got %s\nwant %s", err.Error(), c.msg)
		}
	}
}

func TestCanonicalIP(t *testing.T) {
	cases := map[string]string{
		"2001:DB8:0:0:0:0:0:BAD": "2001:db8::bad",
		"::ffff:203.0.113.7":     "203.0.113.7",
		"::ffff:cb00:7107":       "203.0.113.7",
		"fe80::1%eth0":           "fe80::1",
		"2001:db8:0:1:0:0:0:1":   "2001:db8:0:1::1",
		"2001:0:0:1:0:0:1:1":     "2001::1:0:0:1:1",
		"2001:db8:1:1:1:1:0:1":   "2001:db8:1:1:1:1:0:1",
	}
	for in, want := range cases {
		if got, ok := lxs.CanonicalIP(in); !ok || got != want {
			t.Errorf("CanonicalIP(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "1.2.3.4:80", "[::1]", "01.2.3.4", "1.2.3.4%eth0", "fe80::1%", "fe80::1%a b", " 1.2.3.4"} {
		if got, ok := lxs.CanonicalIP(bad); ok {
			t.Errorf("CanonicalIP(%q) = %q, want invalid", bad, got)
		}
	}
}

func TestEndToEnd(t *testing.T) {
	m, agent := start(t, lxs.Config{
		Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/admin"}, {Type: "web-bait", Path: "/.env"}},
		Assets: []lxs.Asset{{Pattern: "/api/payments/*", Critical: true}},
	}, lxstest.Options{Blocklist: []string{"203.0.113.0/24"}, Watchlist: []string{"198.51.100.9"}})
	h := m.Handler(appHandler)

	if w := do(h, "GET", "/api", "203.0.113.7:1", nil); w.Code != 403 || w.Body.String() != "Forbidden" {
		t.Fatalf("blocked: %d %q", w.Code, w.Body.String())
	}
	w := do(h, "GET", "/admin/login?x=1", "198.51.100.1:1", map[string]string{"Cookie": "sid=1", "X-Ds-Client-Ip": "6.6.6.6"})
	if w.Code != 200 || w.Body.String() != "decoy" {
		t.Fatalf("decoy: %d %q", w.Code, w.Body.String())
	}
	reqs := agent.DecoyRequests()
	if len(reqs) != 1 || reqs[0].Target != "/admin/login?x=1" || reqs[0].Header.Get("X-Ds-Client-Ip") != "198.51.100.1" ||
		reqs[0].Header.Get("X-Ds-Decoy-Id") != "web-admin-admin" || reqs[0].Header.Get("Cookie") != "" {
		t.Fatalf("decoy request: %+v", reqs)
	}
	if w := do(h, "GET", "/api/payments/1", "198.51.100.9:1", nil); w.Body.String() != "app" {
		t.Fatalf("watched pass: %q", w.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		var kinds []string
		for _, s := range agent.Signals() {
			kinds = append(kinds, s.Kind)
		}
		k := strings.Join(kinds, ",")
		if strings.Contains(k, "asset.blocked") && strings.Contains(k, "asset.access") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("signals: %v", k)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestFailOpenWithoutAgent(t *testing.T) {
	dir := t.TempDir()
	m, err := lxs.New(lxs.Config{RunDir: dir, Decoys: []lxs.Decoy{{Type: "web-bait", Path: "/.env"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	h := m.Handler(appHandler)
	if w := do(h, "GET", "/", "203.0.113.7:1", map[string]string{"X-Ds-Foo": "1"}); w.Body.String() != "app" {
		t.Fatalf("pass: %q", w.Body.String())
	}
	// The decoy is unreachable: a generic 404, never the app.
	if w := do(h, "GET", "/.env", "203.0.113.7:1", nil); w.Code != 404 {
		t.Fatalf("decoy unreachable: %d %q", w.Code, w.Body.String())
	}
}

func TestDecoyChunkedBodyOverLimit(t *testing.T) {
	m, agent := start(t, lxs.Config{Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/admin"}}}, lxstest.Options{})
	h := m.Handler(appHandler)
	r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(strings.Repeat("a", 70000)))
	r.ContentLength = -1
	r.RequestURI = "/admin/login"
	r.RemoteAddr = "203.0.113.7:1"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("status %d", w.Code)
	}
	for _, d := range agent.DecoyRequests() {
		if d.Body > 65536 {
			t.Fatalf("decoy received %d body bytes", d.Body)
		}
	}
}

func TestPolicyRefreshUsesETag(t *testing.T) {
	m, agent := start(t, lxs.Config{}, lxstest.Options{})
	h := m.Handler(appHandler)
	if w := do(h, "GET", "/", "203.0.113.7:1", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	served := agent.PolicyServed()
	time.Sleep(200 * time.Millisecond) // several polls, all 304
	if agent.PolicyServed() != served {
		t.Fatalf("unchanged policy re-served: %d -> %d", served, agent.PolicyServed())
	}
	agent.SetPolicy(map[string]any{"blocklist": []string{"203.0.113.7"}})
	deadline := time.Now().Add(2 * time.Second)
	for do(h, "GET", "/", "203.0.113.7:1", nil).Code != 403 {
		if time.Now().After(deadline) {
			t.Fatal("new policy never applied")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
