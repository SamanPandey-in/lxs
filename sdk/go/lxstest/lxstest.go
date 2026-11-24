// Package lxstest provides a fake ds-agent (and optionally a fake ds-web) on the same sockets the
// real sidecars use, so apps can mount the LXS middleware in tests and assert on what it does. It
// mirrors the Node SDK's lxs/testing module.
package lxstest

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
	"github.com/SamanPandey-in/lxs/sdk/go/internal/sock"
)

// Options configures StartFakeAgent.
type Options struct {
	// RunDir will contain the agent/ and web/ socket directories. Pass it as Config.RunDir.
	RunDir      string
	Blocklist   []string
	Allowlist   []string
	Watchlist   []string
	Honeytokens map[string]string // sha256(token) -> honeytoken id
	// FakeDecoy also starts a fake ds-web that records each request and answers 200 "decoy".
	FakeDecoy bool
}

// DecoyRequest is one request the fake ds-web received.
type DecoyRequest struct {
	Method string
	Target string
	Header http.Header
	Host   string
	Body   int
}

// FakeAgent is a running fake ds-agent (and ds-web).
type FakeAgent struct {
	RunDir string

	mu       sync.Mutex
	policy   map[string]any
	version  int
	served   atomic.Int64
	signals  []lxs.Signal
	requests []DecoyRequest

	agentSrv, webSrv *http.Server
	agentLn, webLn   net.Listener
}

// StartFakeAgent starts the fake sidecars. Close it when done.
func StartFakeAgent(opts Options) (*FakeAgent, error) {
	if opts.RunDir == "" {
		return nil, errors.New("lxstest: RunDir is required")
	}
	for _, d := range []string{"agent", "web"} {
		if err := os.MkdirAll(filepath.Join(opts.RunDir, d), 0o755); err != nil {
			return nil, err
		}
	}
	nz := func(s []string) []string {
		if s == nil {
			return []string{}
		}
		return s
	}
	ht := opts.Honeytokens
	if ht == nil {
		ht = map[string]string{}
	}
	f := &FakeAgent{
		RunDir:  opts.RunDir,
		version: 1,
		policy: map[string]any{
			"blocklist":   nz(opts.Blocklist),
			"allowlist":   nz(opts.Allowlist),
			"watchlist":   nz(opts.Watchlist),
			"honeytokens": ht,
		},
	}
	ln, err := sock.Listen(sock.AgentPath(opts.RunDir))
	if err != nil {
		return nil, fmt.Errorf("lxstest: agent socket: %w", err)
	}
	f.agentLn = ln
	f.agentSrv = &http.Server{Handler: http.HandlerFunc(f.serveAgent)}
	go func() { _ = f.agentSrv.Serve(ln) }()

	if opts.FakeDecoy {
		wl, err := sock.Listen(sock.WebPath(opts.RunDir))
		if err != nil {
			f.Close()
			return nil, fmt.Errorf("lxstest: web socket: %w", err)
		}
		f.webLn = wl
		f.webSrv = &http.Server{Handler: http.HandlerFunc(f.serveDecoy)}
		go func() { _ = f.webSrv.Serve(wl) }()
	}
	return f, nil
}

func (f *FakeAgent) serveAgent(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/policy":
		f.mu.Lock()
		etag := fmt.Sprintf(`"pv-%d"`, f.version)
		doc := map[string]any{"version": f.version}
		for k, v := range f.policy {
			doc[k] = v
		}
		f.mu.Unlock()
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		body, _ := json.Marshal(doc)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", etag)
		_, _ = w.Write(body)
		f.served.Add(1)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/signals":
		var body struct {
			Signals []lxs.Signal `json:"signals"`
		}
		if json.NewDecoder(r.Body).Decode(&body) == nil {
			f.mu.Lock()
			f.signals = append(f.signals, body.Signals...)
			f.mu.Unlock()
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("{}"))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *FakeAgent) serveDecoy(w http.ResponseWriter, r *http.Request) {
	n, _ := io.Copy(io.Discard, r.Body)
	f.mu.Lock()
	f.requests = append(f.requests, DecoyRequest{Method: r.Method, Target: r.RequestURI, Header: r.Header.Clone(), Host: r.Host, Body: int(n)})
	f.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("decoy"))
}

// PolicyServed is the number of full (200) policy responses served.
func (f *FakeAgent) PolicyServed() int { return int(f.served.Load()) }

// Signals returns the signals the middleware has posted so far.
func (f *FakeAgent) Signals() []lxs.Signal {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]lxs.Signal(nil), f.signals...)
}

// DecoyRequests returns the requests the fake ds-web has received so far.
func (f *FakeAgent) DecoyRequests() []DecoyRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]DecoyRequest(nil), f.requests...)
}

// SetPolicy replaces some policy lists ("blocklist", "allowlist", "watchlist", "honeytokens") and
// bumps the version (and so the ETag).
func (f *FakeAgent) SetPolicy(p map[string]any) {
	f.mu.Lock()
	for k, v := range p {
		f.policy[k] = v
	}
	f.version++
	f.mu.Unlock()
}

// Close stops both fake sidecars.
func (f *FakeAgent) Close() error {
	if f.agentSrv != nil {
		_ = f.agentSrv.Close()
	}
	if f.webSrv != nil {
		_ = f.webSrv.Close()
	}
	for _, ln := range []net.Listener{f.agentLn, f.webLn} {
		if ln != nil {
			_ = ln.Close()
		}
	}
	return nil
}
