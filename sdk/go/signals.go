package lxs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Signal is one report posted to ds-agent at POST /v1/signals.
type Signal struct {
	Kind     string `json:"kind"`
	IP       string `json:"ip"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	TS       string `json:"ts"`
	Status   int    `json:"status,omitempty"`
	Asset    string `json:"asset,omitempty"`
	Critical *bool  `json:"critical,omitempty"`
	TokenID  string `json:"token_id,omitempty"`
}

const (
	queueMax   = 1000
	batchMax   = 200
	rateWindow = time.Minute
)

func isoNow(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func (m *Middleware) push(s Signal) {
	m.qmu.Lock()
	if len(m.queue) >= queueMax {
		m.queue = m.queue[1:]
		m.dropped++
	}
	m.queue = append(m.queue, s)
	m.qmu.Unlock()
}

// rateAllow lets one signal per (ip, key) through per minute.
func (m *Middleware) rateAllow(ip, key string, now time.Time) bool {
	k := ip + " " + key
	m.rmu.Lock()
	defer m.rmu.Unlock()
	if last, ok := m.rate[k]; ok && now.Sub(last) < rateWindow {
		return false
	}
	if len(m.rate) > 10_000 {
		for kk, t := range m.rate {
			if now.Sub(t) >= rateWindow {
				delete(m.rate, kk)
			}
		}
		if len(m.rate) > 10_000 {
			clear(m.rate)
		}
	}
	m.rate[k] = now
	return true
}

func (m *Middleware) flush(ctx context.Context) {
	if !m.active.Load() {
		return
	}
	m.qmu.Lock()
	if len(m.queue) == 0 && m.dropped == 0 {
		m.qmu.Unlock()
		return
	}
	n := min(len(m.queue), batchMax)
	batch := append([]Signal(nil), m.queue[:n]...)
	m.queue = m.queue[n:]
	dropCount := m.dropped
	m.dropped = 0
	m.qmu.Unlock()

	body, _ := json.Marshal(struct {
		Signals []Signal `json:"signals"`
		Dropped int      `json:"dropped"`
	}{batch, dropCount})
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://ds-agent/v1/signals", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.agent.Do(req)
	if err != nil {
		m.errors.Add(1)
		m.requeue(batch, dropCount)
		m.warnOnce("agent", "agent socket unreachable; failing open (signals are buffered and retried).")
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		m.requeue(batch, dropCount)
	}
}

func (m *Middleware) requeue(batch []Signal, dropCount int) {
	m.qmu.Lock()
	defer m.qmu.Unlock()
	m.queue = append(batch, m.queue...)
	m.dropped += dropCount
	if len(m.queue) > queueMax {
		m.dropped += len(m.queue) - queueMax
		m.queue = m.queue[len(m.queue)-queueMax:]
	}
}

func (m *Middleware) flushLoop() {
	defer m.wg.Done()
	t := time.NewTicker(m.cfg.flush)
	defer t.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-t.C:
			m.flush(m.ctx)
		}
	}
}

// honeytokenCandidate: only values that look like the planted key format are hashed, so real users'
// tokens are never touched. An optional short scheme ("Bearer ") is skipped.
func honeytokenCandidate(raw, prefix string) (string, bool) {
	v := strings.TrimFunc(raw, isJSSpace)
	if sp := strings.IndexByte(v, ' '); sp > 0 && sp < 10 {
		v = strings.TrimFunc(v[sp+1:], isJSSpace)
	}
	if prefix != "" && !strings.HasPrefix(v, prefix) {
		return "", false
	}
	if v == "" || len(v) > 256 {
		return "", false
	}
	return v, true
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
