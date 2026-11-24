// load is a small closed-loop HTTP load generator (autocannon-style): -c keep-alive connections
// each send GET requests back to back for -d, after a -warmup that is not recorded. It prints
// requests/s and latency percentiles as one JSON line.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

func main() {
	url := flag.String("url", "", "target URL")
	label := flag.String("label", "", "label for the result")
	conns := flag.Int("c", 8, "concurrent connections")
	dur := flag.Duration("d", 10*time.Second, "measured duration")
	warm := flag.Duration("warmup", 2*time.Second, "unrecorded warmup")
	flag.Parse()

	tr := &http.Transport{MaxIdleConnsPerHost: *conns, MaxConnsPerHost: *conns, DisableCompression: true}
	client := &http.Client{Transport: tr}
	req := func() (time.Duration, error) {
		r, _ := http.NewRequest("GET", *url, nil)
		r.Header.Set("User-Agent", "Mozilla/5.0")
		r.Header.Set("Accept", "application/json")
		t0 := now()
		resp, err := client.Do(r)
		if err != nil {
			return 0, err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return 0, fmt.Errorf("status %d", resp.StatusCode)
		}
		return since(t0), nil
	}

	var mu sync.Mutex
	var all []time.Duration
	errs := 0
	start := time.Now()
	measureFrom := start.Add(*warm)
	end := measureFrom.Add(*dur)
	var wg sync.WaitGroup
	for i := 0; i < *conns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			local := make([]time.Duration, 0, 1<<16)
			for {
				now := time.Now()
				if now.After(end) {
					break
				}
				d, err := req()
				if err != nil {
					mu.Lock()
					errs++
					mu.Unlock()
					continue
				}
				if now.After(measureFrom) {
					local = append(local, d)
				}
			}
			mu.Lock()
			all = append(all, local...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })
	pct := func(p float64) float64 {
		if len(all) == 0 {
			return 0
		}
		i := int(p * float64(len(all)-1))
		return float64(all[i].Microseconds()) / 1000
	}
	out := map[string]any{
		"label": *label, "requests": len(all), "errors": errs,
		"rps":    float64(len(all)) / dur.Seconds(),
		"p50_ms": pct(0.50), "p90_ms": pct(0.90), "p99_ms": pct(0.99), "max_ms": pct(1),
	}
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
