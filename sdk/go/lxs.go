// Package lxs is the Go middleware for LXS: it routes requests for decoy paths to the local decoy
// server, strips client-supplied x-ds-* headers, derives the client IP safely, and enforces the
// blocklist served by the local agent. It implements conformance/SPEC.md and passes every vector
// in conformance/vectors.
//
// Mount it first, in front of routing, body parsing and auth:
//
//	m, err := lxs.New(lxs.Config{Decoys: []lxs.Decoy{{Type: "web-admin", Path: "/admin"}}})
//	if err != nil { log.Fatal(err) }
//	defer m.Close()
//	http.ListenAndServe(":8080", m.Handler(appHandler))
package lxs

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SamanPandey-in/lxs/sdk/go/internal/sock"
)

// Middleware is safe for concurrent use. Create it once with New and Close it on shutdown.
type Middleware struct {
	cfg           *resolvedConfig
	decoys        *decoyMatcher
	assets        assetMatcher
	runDirPresent func(string) bool

	active atomic.Bool
	policy atomic.Pointer[policy]
	errors atomic.Int64

	agent *http.Client
	web   *http.Transport

	qmu     sync.Mutex
	queue   []Signal
	dropped int

	rmu  sync.Mutex
	rate map[string]time.Time

	wmu      sync.Mutex
	lastWarn map[string]time.Time

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	once   sync.Once
}

// New validates cfg and starts the policy poller and the signal flusher. Configuration errors are
// *ConfigError values with the Node SDK's codes (E_TRUST_PROXY, E_OPTIONS, E_MOUNT_INVALID, ...).
func New(cfg Config) (*Middleware, error) {
	rc, err := resolveConfig(cfg)
	if err != nil {
		return nil, err
	}
	m := &Middleware{
		cfg:           rc,
		decoys:        newDecoyMatcher(rc.decoys),
		assets:        assetMatcher{assets: rc.assets},
		runDirPresent: sock.RunDirPresent,
		rate:          map[string]time.Time{},
		lastWarn:      map[string]time.Time{},
	}
	m.policy.Store(emptyPolicy)
	if rc.disabled {
		return m, nil
	}
	agentSock := sock.AgentPath(rc.runDir)
	webSock := sock.WebPath(rc.runDir)
	m.agent = &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (netConn, error) {
				return sock.Dial(ctx, agentSock)
			},
			MaxIdleConnsPerHost: 2,
			IdleConnTimeout:     30 * time.Second,
		},
		Timeout: 1500 * time.Millisecond,
	}
	m.web = &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (netConn, error) {
			return sock.Dial(ctx, webSock)
		},
		DisableCompression:    true,
		ResponseHeaderTimeout: rc.decoyTTL,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       30 * time.Second,
	}
	m.active.Store(sock.RunDirPresent(rc.runDir))
	if !m.active.Load() {
		m.warnOnce("norundir", rc.runDir+" not found; middleware is a no-op (run via docker compose with lxs.compose.yml).")
	}
	m.ctx, m.cancel = context.WithCancel(context.Background())
	m.wg.Add(2)
	go m.pollLoop()
	go m.flushLoop()
	return m, nil
}

// Close stops the policy poller and the signal flusher and closes idle sidecar connections.
func (m *Middleware) Close() error {
	m.once.Do(func() {
		if m.cancel != nil {
			m.cancel()
			m.wg.Wait()
		}
		if m.web != nil {
			m.web.CloseIdleConnections()
		}
		if m.agent != nil {
			m.agent.CloseIdleConnections()
		}
	})
	return nil
}

// Stats reports the middleware's internal counters.
type Stats struct {
	Queued       int
	Dropped      int
	Errors       int64
	Active       bool
	PolicyLoaded bool
	PolicyETag   string
}

// Stats returns a snapshot of the middleware's counters.
func (m *Middleware) Stats() Stats {
	m.qmu.Lock()
	q, d := len(m.queue), m.dropped
	m.qmu.Unlock()
	p := m.policy.Load()
	return Stats{Queued: q, Dropped: d, Errors: m.errors.Load(), Active: m.active.Load(), PolicyLoaded: p.loaded, PolicyETag: p.etag}
}

func (m *Middleware) warnOnce(key, msg string) {
	now := time.Now()
	m.wmu.Lock()
	last, ok := m.lastWarn[key]
	if ok && now.Sub(last) < time.Minute {
		m.wmu.Unlock()
		return
	}
	m.lastWarn[key] = now
	m.wmu.Unlock()
	defer func() { _ = recover() }() // never throw into the app
	m.cfg.logger.Warn("lxs: " + msg)
}

// Handler wraps next (the app) for net/http. Decoy paths and blocked clients never reach next.
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handled, done := m.Process(w, r)
		if handled {
			return
		}
		if done == nil {
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		done(sw.status)
	})
}

// Process is the framework-neutral hot path used by Handler and the framework adapters. If handled
// is true the middleware has written the response and the app must not run. Otherwise the request
// (with x-ds-* headers removed) goes to the app; if done is non-nil, call it with the response
// status once the app has finished.
func (m *Middleware) Process(w http.ResponseWriter, r *http.Request) (handled bool, done func(status int)) {
	if m == nil || m.cfg.disabled {
		return false, nil
	}
	act, done := m.decide(w, r)
	if act == actHandled {
		return true, nil
	}
	// Every pass goes through here: the app never sees a client-supplied x-ds-* header.
	stripDSHeaders(r.Header)
	return false, done
}

type action int

const (
	actPass action = iota
	actHandled
)

func (m *Middleware) decide(w http.ResponseWriter, r *http.Request) (act action, done func(int)) {
	wrote := false
	defer func() {
		if rec := recover(); rec != nil {
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			m.errors.Add(1)
			m.warnOnce("hotpath", "request handling error (failing open)")
			if wrote {
				act, done = actHandled, nil
			} else {
				act, done = actPass, nil
			}
		}
	}()
	if !m.active.Load() {
		return actPass, nil
	}
	c := m.clientIP(r)
	if m.cfg.allow.contains(c.addr) {
		return actPass, nil
	}
	pol := m.policy.Load()
	if pol.allow.contains(c.addr) {
		return actPass, nil
	}
	target := originForm(r.RequestURI)
	path := matchPath(target)

	if m.cfg.enforce && pol.blocked(c.addr) {
		now := time.Now()
		ip := c.String()
		if m.rateAllow(ip, "blocked "+path, now) {
			m.push(Signal{Kind: "asset.blocked", IP: ip, Method: r.Method, Path: path, TS: isoNow(now)})
		}
		wrote = true
		writePlain(w, http.StatusForbidden, "Forbidden") // generic body, no product name
		return actHandled, nil
	}

	if m.decoys.size() > 0 {
		if d := m.decoys.match(path); d != nil {
			wrote = true
			m.proxy(w, r, d, c.String(), target)
			return actHandled, nil // never the app: decoy paths must not reach it
		}
	}

	if m.cfg.htHeader != "" && len(pol.honeytokens) > 0 {
		if raw := r.Header.Get(m.cfg.htHeader); raw != "" {
			if tok, ok := honeytokenCandidate(raw, m.cfg.htPrefix); ok {
				if id, ok := pol.honeytokens[sha256Hex(tok)]; ok {
					m.push(Signal{Kind: "honeytoken.use", IP: c.String(), Method: r.Method, Path: path, TS: isoNow(time.Now()), TokenID: id})
				}
			}
		}
	}

	if pol.watched(c.addr) {
		now := time.Now()
		ip := c.String()
		if m.rateAllow(ip, path, now) {
			asset := m.assets.match(path)
			method := r.Method
			return actPass, func(status int) {
				s := Signal{Kind: "asset.access", IP: ip, Method: method, Path: path, TS: isoNow(time.Now()), Status: status}
				if asset != nil {
					crit := asset.critical
					s.Asset, s.Critical = asset.name, &crit
				}
				m.push(s)
			}
		}
	}
	return actPass, nil
}

// stripDSHeaders deletes every header in the x-ds- namespace (any case).
func stripDSHeaders(h http.Header) {
	for k := range h {
		if hasDSPrefix(k) {
			delete(h, k)
		}
	}
}

func hasDSPrefix(k string) bool {
	return len(k) >= 5 && strings.EqualFold(k[:5], "x-ds-")
}

func writePlain(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// statusWriter records the status the app wrote (only used for watchlisted clients).
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status, s.wroteHeader = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wroteHeader = true
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
