// Package bench measures the LXS middleware's overhead on a non-decoy route. See
// docs/PERFORMANCE.md, "Middleware overhead".
package bench

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
	"github.com/SamanPandey-in/lxs/sdk/go/lxstest"
)

// Policy is the policy the fake agent serves: 1000 exact addresses and 50 CIDRs on the blocklist,
// a small allowlist. conformance/bench/node/server.mjs builds the same one.
func Policy() (block, allow []string) {
	for i := 0; i < 1000; i++ {
		block = append(block, fmt.Sprintf("198.18.%d.%d", i/250, i%250+1))
	}
	for i := 0; i < 50; i++ {
		block = append(block, fmt.Sprintf("100.64.%d.0/24", i))
	}
	return block, []string{"192.0.2.0/24", "2001:db8::/32"}
}

// Decoys are two typical decoys; the benchmarked route matches neither.
var Decoys = []lxs.Decoy{{Type: "web-admin", Path: "/admin"}, {Type: "web-bait", Path: "/.env"}}

// App is the handler being protected: a small JSON answer, no I/O.
var App = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"products":[{"id":1,"name":"widget"}],"page":2}`)
})

// Start starts a fake agent in a fresh run directory and a middleware that has loaded its policy.
func Start() (m *lxs.Middleware, cleanup func(), err error) {
	dir, err := os.MkdirTemp("", "lxs-bench-")
	if err != nil {
		return nil, nil, err
	}
	block, allow := Policy()
	agent, err := lxstest.StartFakeAgent(lxstest.Options{RunDir: dir, FakeDecoy: true, Blocklist: block, Allowlist: allow})
	if err != nil {
		return nil, nil, err
	}
	m, err = lxs.New(lxs.Config{RunDir: dir, Decoys: Decoys, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		agent.Close()
		return nil, nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for !m.Stats().PolicyLoaded {
		if time.Now().After(deadline) {
			return nil, nil, fmt.Errorf("policy not loaded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return m, func() { m.Close(); agent.Close(); os.RemoveAll(dir) }, nil
}
