// Package runner drives conformance/vectors against the Go middleware (net/http, chi, gin, echo),
// the way conformance/runners/node does for Express and Fastify: raw request bytes over TCP, a
// simulated TCP peer address, and a fake ds-agent and ds-web on the real socket paths (Unix sockets,
// or named pipes on Windows).
package runner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// HeaderAssertions maps a lower-case header name to a string (exact value), true (present,
// non-empty) or nil (absent).
type HeaderAssertions map[string]any

type DecoyConfig struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Prefix bool   `json:"prefix"`
}

type Vector struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Config      struct {
		Mode       string        `json:"mode"`
		TrustProxy any           `json:"trustProxy"`
		Allowlist  []string      `json:"allowlist"`
		Decoys     []DecoyConfig `json:"decoys"`
	} `json:"config"`
	Policy struct {
		Blocklist []string `json:"blocklist"`
		Allowlist []string `json:"allowlist"`
	} `json:"policy"`
	Request struct {
		Method        string      `json:"method"`
		Target        string      `json:"target"`
		Headers       [][2]string `json:"headers"`
		RemoteAddress string      `json:"remoteAddress"`
		Body          *string     `json:"body"`
		BodyBytes     *int        `json:"bodyBytes"`
	} `json:"request"`
	Expect struct {
		Outcome string `json:"outcome"`
		App     *struct {
			Headers HeaderAssertions `json:"headers"`
		} `json:"app"`
		Decoy *struct {
			ID       string           `json:"id"`
			ClientIP string           `json:"clientIp"`
			Method   *string          `json:"method"`
			Target   *string          `json:"target"`
			Headers  HeaderAssertions `json:"headers"`
		} `json:"decoy"`
		Status             int  `json:"status"`
		FrameworkMayReject bool `json:"frameworkMayReject"`
	} `json:"expect"`
}

type VectorFile struct {
	File     string
	Category string
	Vectors  []Vector
}

// VectorsDir is conformance/vectors, found relative to this source file, or $LXS_CONFORMANCE_VECTORS.
func VectorsDir() string {
	if d := os.Getenv("LXS_CONFORMANCE_VECTORS"); d != "" {
		return d
	}
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "vectors")
}

// LoadVectorFiles reads every *.json file in dir, sorted by name.
func LoadVectorFiles(dir string) ([]VectorFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	var out []VectorFile
	for _, n := range names {
		data, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			return nil, err
		}
		var doc struct {
			Category string   `json:"category"`
			Vectors  []Vector `json:"vectors"`
		}
		if err := json.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("%s: %w", n, err)
		}
		out = append(out, VectorFile{File: n, Category: doc.Category, Vectors: doc.Vectors})
	}
	return out, nil
}

/* ---- format validation: conformance/schema/vector.schema.json, checked by hand ---- */

var (
	categoryRe   = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	nameRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	idRe         = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	methodRe     = regexp.MustCompile(`^[A-Z]+$`)
	headerNameRe = regexp.MustCompile(`^[a-z0-9-]+$`)
)

type validator struct{ problems []string }

func (v *validator) fail(path, format string, a ...any) {
	v.problems = append(v.problems, path+": "+fmt.Sprintf(format, a...))
}

func (v *validator) object(path string, x any, required []string, allowed ...string) map[string]any {
	o, ok := x.(map[string]any)
	if !ok {
		v.fail(path, "must be an object")
		return nil
	}
	for _, r := range required {
		if _, ok := o[r]; !ok {
			v.fail(path, "missing required property %q", r)
		}
	}
	all := map[string]bool{}
	for _, a := range append(required, allowed...) {
		all[a] = true
	}
	for k := range o {
		if !all[k] {
			v.fail(path, "unexpected property %q", k)
		}
	}
	return o
}

func (v *validator) str(path string, x any, re *regexp.Regexp) {
	s, ok := x.(string)
	if !ok {
		v.fail(path, "must be a string")
		return
	}
	if re != nil && !re.MatchString(s) {
		v.fail(path, "%q does not match %s", s, re)
	}
}

func (v *validator) strArray(path string, x any) {
	a, ok := x.([]any)
	if !ok {
		v.fail(path, "must be an array")
		return
	}
	for i, e := range a {
		v.str(fmt.Sprintf("%s[%d]", path, i), e, nil)
	}
}

func isInteger(x any) (int64, bool) {
	n, ok := x.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

func (v *validator) headerAssertions(path string, x any) {
	o, ok := x.(map[string]any)
	if !ok {
		v.fail(path, "must be an object")
		return
	}
	for k, val := range o {
		if !headerNameRe.MatchString(k) {
			v.fail(path, "header name %q must be lower case", k)
		}
		switch val.(type) {
		case string, nil:
		case bool:
			if val == false {
				v.fail(path+"."+k, "false is not allowed")
			}
		default:
			v.fail(path+"."+k, "must be a string, true or null")
		}
	}
}

func (v *validator) vector(path string, x any) {
	o := v.object(path, x, []string{"name", "description", "config", "policy", "request", "expect"})
	if o == nil {
		return
	}
	v.str(path+".name", o["name"], nameRe)
	v.str(path+".description", o["description"], nil)

	if c := v.object(path+".config", o["config"], []string{"mode", "trustProxy", "allowlist", "decoys"}); c != nil {
		if m, _ := c["mode"].(string); m != "enforce" && m != "monitor" {
			v.fail(path+".config.mode", "must be enforce or monitor")
		}
		switch tp := c["trustProxy"].(type) {
		case bool:
			if tp {
				v.fail(path+".config.trustProxy", "true is not allowed")
			}
		case []any:
			v.strArray(path+".config.trustProxy", tp)
		default:
			if n, ok := isInteger(tp); !ok || n < 1 || n > 10 {
				v.fail(path+".config.trustProxy", "must be false, an integer 1..10 or a list of strings")
			}
		}
		v.strArray(path+".config.allowlist", c["allowlist"])
		if ds, ok := c["decoys"].([]any); !ok {
			v.fail(path+".config.decoys", "must be an array")
		} else {
			for i, d := range ds {
				p := fmt.Sprintf("%s.config.decoys[%d]", path, i)
				if dobj := v.object(p, d, []string{"id", "path", "prefix"}); dobj != nil {
					v.str(p+".id", dobj["id"], idRe)
					v.str(p+".path", dobj["path"], regexp.MustCompile(`^/`))
					if _, ok := dobj["prefix"].(bool); !ok {
						v.fail(p+".prefix", "must be a boolean")
					}
				}
			}
		}
	}
	if p := v.object(path+".policy", o["policy"], []string{"blocklist", "allowlist"}); p != nil {
		v.strArray(path+".policy.blocklist", p["blocklist"])
		v.strArray(path+".policy.allowlist", p["allowlist"])
	}
	if r := v.object(path+".request", o["request"], []string{"method", "target", "headers", "remoteAddress"}, "body", "bodyBytes"); r != nil {
		v.str(path+".request.method", r["method"], methodRe)
		if t, _ := r["target"].(string); t == "" {
			v.fail(path+".request.target", "must be a non-empty string")
		}
		if hs, ok := r["headers"].([]any); !ok {
			v.fail(path+".request.headers", "must be an array")
		} else {
			for i, h := range hs {
				pair, ok := h.([]any)
				if !ok || len(pair) != 2 {
					v.fail(fmt.Sprintf("%s.request.headers[%d]", path, i), "must be a [name, value] pair")
					continue
				}
				if n, ok := pair[0].(string); !ok || n == "" {
					v.fail(fmt.Sprintf("%s.request.headers[%d][0]", path, i), "must be a non-empty string")
				}
				if _, ok := pair[1].(string); !ok {
					v.fail(fmt.Sprintf("%s.request.headers[%d][1]", path, i), "must be a string")
				}
			}
		}
		v.str(path+".request.remoteAddress", r["remoteAddress"], nil)
		if b, ok := r["body"]; ok {
			v.str(path+".request.body", b, nil)
		}
		if b, ok := r["bodyBytes"]; ok {
			if n, ok := isInteger(b); !ok || n < 0 {
				v.fail(path+".request.bodyBytes", "must be a non-negative integer")
			}
		}
		_, hasBody := r["body"]
		_, hasBytes := r["bodyBytes"]
		if hasBody && hasBytes {
			v.fail(path+".request", "body and bodyBytes are mutually exclusive")
		}
	}
	if e := v.object(path+".expect", o["expect"], []string{"outcome"}, "app", "decoy", "status", "frameworkMayReject"); e != nil {
		outcome, _ := e["outcome"].(string)
		switch outcome {
		case "pass_through", "decoy", "blocked":
		default:
			v.fail(path+".expect.outcome", "must be pass_through, decoy or blocked")
		}
		if a, ok := e["app"]; ok {
			if ao := v.object(path+".expect.app", a, nil, "headers"); ao != nil {
				if h, ok := ao["headers"]; ok {
					v.headerAssertions(path+".expect.app.headers", h)
				}
			}
		}
		if d, ok := e["decoy"]; ok {
			if do := v.object(path+".expect.decoy", d, []string{"id", "clientIp"}, "method", "target", "headers"); do != nil {
				v.str(path+".expect.decoy.id", do["id"], nil)
				v.str(path+".expect.decoy.clientIp", do["clientIp"], nil)
				for _, k := range []string{"method", "target"} {
					if x, ok := do[k]; ok {
						v.str(path+".expect.decoy."+k, x, nil)
					}
				}
				if h, ok := do["headers"]; ok {
					v.headerAssertions(path+".expect.decoy.headers", h)
				}
			}
		} else if outcome == "decoy" {
			v.fail(path+".expect", "outcome decoy requires decoy")
		}
		if s, ok := e["status"]; ok {
			if _, ok := isInteger(s); !ok {
				v.fail(path+".expect.status", "must be an integer")
			}
		} else if outcome == "blocked" {
			v.fail(path+".expect", "outcome blocked requires status")
		}
		if f, ok := e["frameworkMayReject"]; ok {
			if _, ok := f.(bool); !ok {
				v.fail(path+".expect.frameworkMayReject", "must be a boolean")
			}
		}
	}
}

// ValidateFile checks one vector file against conformance/schema/vector.schema.json.
func ValidateFile(name string, data []byte) []string {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return []string{name + ": " + err.Error()}
	}
	v := &validator{}
	if o := v.object(name, doc, []string{"category", "vectors"}, "$schema", "description"); o != nil {
		if s, ok := o["$schema"]; ok {
			v.str(name+".$schema", s, nil)
		}
		if s, ok := o["description"]; ok {
			v.str(name+".description", s, nil)
		}
		v.str(name+".category", o["category"], categoryRe)
		vs, ok := o["vectors"].([]any)
		if !ok || len(vs) == 0 {
			v.fail(name+".vectors", "must be a non-empty array")
		}
		for i, x := range vs {
			v.vector(fmt.Sprintf("%s.vectors[%d]", name, i), x)
		}
	}
	return v.problems
}
