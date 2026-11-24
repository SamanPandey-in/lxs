package bench

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// In-process cost of the middleware on a non-decoy route, no network: ServeHTTP with and without
// it. The difference is the per-request overhead.
func newReq() *http.Request {
	r := httptest.NewRequest("GET", "/api/products?page=2", nil)
	r.RequestURI = "/api/products?page=2"
	r.RemoteAddr = "203.0.113.7:40000"
	r.Header.Set("User-Agent", "Mozilla/5.0")
	r.Header.Set("Accept", "application/json")
	return r
}

func run(b *testing.B, h http.Handler) {
	b.ReportAllocs()
	for b.Loop() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, newReq())
	}
}

func BenchmarkBare(b *testing.B) { run(b, App) }

func BenchmarkWithLXS(b *testing.B) {
	m, cleanup, err := Start()
	if err != nil {
		b.Fatal(err)
	}
	defer cleanup()
	run(b, m.Handler(App))
}

// BenchmarkProcess isolates the middleware's own work (client IP, allowlists, blocklist, decoy
// match, x-ds-* strip) on one reused request: the counterpart of conformance/bench/node/micro.mjs.
func BenchmarkProcess(b *testing.B) {
	m, cleanup, err := Start()
	if err != nil {
		b.Fatal(err)
	}
	defer cleanup()
	r := newReq()
	w := httptest.NewRecorder()
	b.ReportAllocs()
	for b.Loop() {
		if handled, _ := m.Process(w, r); handled {
			b.Fatal("handled a non-decoy request")
		}
	}
}
