package runner

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
	"github.com/labstack/echo/v4"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
	lxschi "github.com/SamanPandey-in/lxs/sdk/go/chi"
	lxsecho "github.com/SamanPandey-in/lxs/sdk/go/echo"
	lxsgin "github.com/SamanPandey-in/lxs/sdk/go/gin"
	"github.com/SamanPandey-in/lxs/sdk/go/lxstest"
)

// Frameworks the Go SDK ships adapters for.
var Frameworks = []string{"net/http", "chi", "gin", "echo"}

// remoteHeader carries the simulated TCP peer address; removed before the middleware runs.
const remoteHeader = "X-Conformance-Remote-Address"

func init() { gin.SetMode(gin.ReleaseMode) }

type seen struct {
	header http.Header
	body   int
}

type app struct {
	mu   sync.Mutex
	hits []seen
}

func (a *app) record(r *http.Request) {
	n, _ := io.Copy(io.Discard, r.Body)
	a.mu.Lock()
	a.hits = append(a.hits, seen{header: r.Header.Clone(), body: int(n)})
	a.mu.Unlock()
}

func (a *app) snapshot() []seen {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]seen(nil), a.hits...)
}

func (a *app) nethttp(w http.ResponseWriter, r *http.Request) {
	a.record(r)
	_, _ = io.WriteString(w, "app")
}

// mount builds the framework app with the middleware first and a catch-all app handler.
func mount(framework string, m *lxs.Middleware, a *app) http.Handler {
	switch framework {
	case "net/http":
		return m.Handler(http.HandlerFunc(a.nethttp))
	case "chi":
		r := chi.NewRouter()
		r.Use(lxschi.Middleware(m))
		r.HandleFunc("/*", a.nethttp)
		r.NotFound(a.nethttp)
		r.MethodNotAllowed(a.nethttp)
		return r
	case "gin":
		r := gin.New()
		r.Use(lxsgin.Middleware(m))
		r.NoRoute(func(c *gin.Context) {
			a.record(c.Request)
			c.String(http.StatusOK, "app")
		})
		return r
	case "echo":
		e := echo.New()
		e.HideBanner, e.HidePort = true, true
		e.Pre(lxsecho.Middleware(m))
		h := func(c echo.Context) error {
			a.record(c.Request())
			return c.String(http.StatusOK, "app")
		}
		e.Any("/*", h)
		e.RouteNotFound("/*", h)
		return e
	}
	panic("unknown framework " + framework)
}

// withRemote sets r.RemoteAddr from the private header, then removes it.
func withRemote(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v := r.Header.Get(remoteHeader); v != "" {
			r.RemoteAddr = net.JoinHostPort(v, "40000")
		}
		r.Header.Del(remoteHeader)
		h.ServeHTTP(w, r)
	})
}

var statusLine = regexp.MustCompile(`^HTTP/1\.[01] (\d{3})`)

// send writes the request byte for byte (duplicate headers, odd targets) and returns the status.
func send(addr string, v *Vector) (int, error) {
	r := v.Request
	var body []byte
	switch {
	case r.BodyBytes != nil:
		body = bytes.Repeat([]byte("a"), *r.BodyBytes)
	case r.Body != nil:
		body = []byte(*r.Body)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", r.Method, r.Target)
	hasHost := false
	for _, h := range r.Headers {
		if strings.EqualFold(h[0], "host") {
			hasHost = true
		}
	}
	if !hasHost {
		b.WriteString("Host: conformance.test\r\n")
	}
	for _, h := range r.Headers {
		fmt.Fprintf(&b, "%s: %s\r\n", h[0], h[1])
	}
	fmt.Fprintf(&b, "%s: %s\r\n", remoteHeader, r.RemoteAddress)
	b.WriteString("Connection: close\r\n")
	if body != nil {
		fmt.Fprintf(&b, "Content-Length: %d\r\n", len(body))
	}
	b.WriteString("\r\n")

	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	go func() {
		// Write concurrently: a server answering 413 early may stop reading.
		_, _ = conn.Write(append([]byte(b.String()), body...))
	}()
	line, err := bufio.NewReader(conn).ReadString('\n')
	if mm := statusLine.FindStringSubmatch(line); mm != nil {
		n, _ := strconv.Atoi(mm[1])
		return n, nil
	}
	return 0, fmt.Errorf("no HTTP status line in response %q (%v)", line, err)
}

func headerText(h http.Header, name string) (string, bool) {
	vals := h.Values(name)
	if len(vals) == 0 {
		// Header names Go could not canonicalise are stored as sent.
		for k, vv := range h {
			if strings.EqualFold(k, name) {
				vals = append(vals, vv...)
			}
		}
	}
	if len(vals) == 0 {
		return "", false
	}
	return strings.Join(vals, ", "), true
}

func checkHeaders(where string, actual http.Header, expected HeaderAssertions, problems *[]string) {
	for name, want := range expected {
		got, present := headerText(actual, name)
		switch w := want.(type) {
		case nil:
			if present {
				*problems = append(*problems, fmt.Sprintf("%s header %s: expected absent, got %q", where, name, got))
			}
		case bool:
			if !present || got == "" {
				*problems = append(*problems, fmt.Sprintf("%s header %s: expected present", where, name))
			}
		case string:
			if !present || got != w {
				*problems = append(*problems, fmt.Sprintf("%s header %s: expected %q, got %q (present %v)", where, name, w, got, present))
			}
		}
	}
}

func buildConfig(v *Vector, runDir string) lxs.Config {
	cfg := lxs.Config{
		RunDir:    runDir,
		Mode:      v.Config.Mode,
		Allowlist: v.Config.Allowlist,
		Logger:    quietLogger,
	}
	switch tp := v.Config.TrustProxy.(type) {
	case []any:
		list := make([]string, len(tp))
		for i, x := range tp {
			list[i], _ = x.(string)
		}
		cfg.TrustProxy = list
	default:
		cfg.TrustProxy = tp // false or a JSON number (float64)
	}
	for _, d := range v.Config.Decoys {
		if d.Prefix {
			cfg.Decoys = append(cfg.Decoys, lxs.Decoy{Type: "web-admin", Path: d.Path, ID: d.ID})
		} else {
			cfg.Decoys = append(cfg.Decoys, lxs.Decoy{Type: "web-bait", Path: d.Path, ID: d.ID, Template: "dotenv"})
		}
	}
	return cfg
}

// RunVector runs one vector against one framework and returns the mismatches (empty = pass).
func RunVector(v *Vector, framework string) (problems []string, err error) {
	runDir, err := os.MkdirTemp("", "lxs-conf-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(runDir)
	agent, err := lxstest.StartFakeAgent(lxstest.Options{
		RunDir: runDir, FakeDecoy: true, Blocklist: v.Policy.Blocklist, Allowlist: v.Policy.Allowlist,
	})
	if err != nil {
		return nil, err
	}
	defer agent.Close()
	m, err := lxs.New(buildConfig(v, runDir))
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	defer m.Close()

	a := &app{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	srv := &http.Server{Handler: withRemote(mount(framework, m, a)), ErrorLog: quietStdLogger}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		_ = srv.Close()
	}()

	// Wait until the middleware has applied the policy.
	deadline := time.Now().Add(3 * time.Second)
	for !m.Stats().PolicyLoaded {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timed out waiting for the first policy poll (served %d)", agent.PolicyServed())
		}
		time.Sleep(2 * time.Millisecond)
	}

	status, err := send(ln.Addr().String(), v)
	if err != nil {
		return nil, err
	}
	time.Sleep(time.Millisecond) // stragglers: both fakes record before answering

	hits := a.snapshot()
	decoys := agent.DecoyRequests()
	e := v.Expect
	if e.FrameworkMayReject && status == 400 && len(hits) == 0 && len(decoys) == 0 {
		return nil, nil
	}
	switch e.Outcome {
	case "pass_through":
		if len(hits) != 1 || len(decoys) != 0 || status != 200 {
			problems = append(problems, fmt.Sprintf("expected pass_through, got status %d (app hits %d, decoy hits %d)", status, len(hits), len(decoys)))
		} else if e.App != nil {
			checkHeaders("app", hits[0].header, e.App.Headers, &problems)
		}
	case "decoy":
		if len(decoys) != 1 || len(hits) != 0 || status != 200 {
			problems = append(problems, fmt.Sprintf("expected decoy, got status %d (app hits %d, decoy hits %d)", status, len(hits), len(decoys)))
			break
		}
		d := decoys[0]
		want := e.Decoy
		assert := HeaderAssertions{"x-ds-decoy-id": want.ID, "x-ds-client-ip": want.ClientIP, "x-ds-request-id": true}
		for k, val := range want.Headers {
			assert[k] = val
		}
		checkHeaders("decoy", d.Header, assert, &problems)
		if want.Method != nil && d.Method != *want.Method {
			problems = append(problems, fmt.Sprintf("decoy method: expected %s, got %s", *want.Method, d.Method))
		}
		if want.Target != nil && d.Target != *want.Target {
			problems = append(problems, fmt.Sprintf("decoy target: expected %s, got %s", *want.Target, d.Target))
		}
	default: // blocked
		if status != e.Status || len(hits) != 0 || len(decoys) != 0 {
			problems = append(problems, fmt.Sprintf("expected blocked %d, got status %d (app hits %d, decoy hits %d)", e.Status, status, len(hits), len(decoys)))
		}
	}
	return problems, nil
}
