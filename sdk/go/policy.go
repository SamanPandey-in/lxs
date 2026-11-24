package lxs

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// policy is an immutable snapshot of the agent's policy document. Swapped atomically.
type policy struct {
	etag        string
	loaded      bool
	blockExact  map[netip.Addr]struct{}
	blockCIDRs  []netip.Prefix
	watch       map[netip.Addr]struct{}
	honeytokens map[string]string
	allow       *ipSet
}

var emptyPolicy = &policy{}

func (p *policy) blocked(a netip.Addr) bool {
	if !a.IsValid() {
		return false
	}
	if _, ok := p.blockExact[a]; ok {
		return true
	}
	for _, c := range p.blockCIDRs {
		if c.Contains(a) {
			return true
		}
	}
	return false
}

func (p *policy) watched(a netip.Addr) bool {
	if len(p.watch) == 0 || !a.IsValid() {
		return false
	}
	_, ok := p.watch[a]
	return ok
}

// stringList keeps the string items of a JSON array and ignores everything else.
func stringList(raw json.RawMessage) []string {
	var items []any
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, x := range items {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// parsePolicy builds a snapshot. Invalid entries are ignored, never widened; /0 policy allowlist
// entries are dropped (they would switch blocking off for everyone).
func (m *Middleware) parsePolicy(body []byte, etag string) (*policy, error) {
	var doc map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	p := &policy{etag: etag, loaded: true, blockExact: map[netip.Addr]struct{}{}}
	for _, e := range stringList(doc["blocklist"]) {
		if strings.IndexByte(e, '/') >= 0 {
			if c, ok := parseCIDR(e); ok {
				p.blockCIDRs = append(p.blockCIDRs, c)
			}
		} else if a, ok := parseIP(e); ok {
			p.blockExact[a] = struct{}{}
		}
	}
	for _, e := range stringList(doc["watchlist"]) {
		if a, ok := parseIP(e); ok {
			if p.watch == nil {
				p.watch = map[netip.Addr]struct{}{}
			}
			p.watch[a] = struct{}{}
		}
	}
	var ht map[string]any
	if raw, ok := doc["honeytokens"]; ok && json.Unmarshal(raw, &ht) == nil {
		for hash, id := range ht {
			if s, ok := id.(string); ok {
				if p.honeytokens == nil {
					p.honeytokens = map[string]string{}
				}
				p.honeytokens[hash] = s
			}
		}
	}
	allow := stringList(doc["allowlist"])
	safe := allow[:0:0]
	for _, a := range allow {
		if !isMatchAll(a) {
			safe = append(safe, a)
		}
	}
	if len(safe) != len(allow) {
		m.warnOnce("allow0", "ignored a /0 entry in the platform allowlist (it would disable blocking).")
	}
	p.allow = buildIPSet(safe, true)
	return p, nil
}

// refreshPolicy fetches GET /v1/policy with If-None-Match. Any failure keeps the last good policy:
// the middleware fails open and never blocks or fails a request because the agent is down.
func (m *Middleware) refreshPolicy(ctx context.Context) {
	if !m.active.Load() {
		if m.runDirPresent(m.cfg.runDir) {
			m.active.Store(true)
		} else {
			return
		}
	}
	cur := m.policy.Load()
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://ds-agent/v1/policy", nil)
	if cur.etag != "" {
		req.Header.Set("If-None-Match", cur.etag)
	}
	resp, err := m.agent.Do(req)
	if err != nil {
		m.errors.Add(1)
		m.warnOnce("agent", "agent socket unreachable; failing open (using last known policy).")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		_, _ = io.Copy(io.Discard, resp.Body)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20+1))
	if err != nil || len(body) > 4<<20 || resp.StatusCode != http.StatusOK {
		if err != nil {
			m.errors.Add(1)
		}
		return
	}
	p, err := m.parsePolicy(body, resp.Header.Get("ETag"))
	if err != nil {
		m.errors.Add(1)
		return
	}
	m.policy.Store(p)
}

func (m *Middleware) pollLoop() {
	defer m.wg.Done()
	m.refreshPolicy(m.ctx)
	t := time.NewTicker(m.cfg.poll)
	defer t.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-t.C:
			m.refreshPolicy(m.ctx)
		}
	}
}
