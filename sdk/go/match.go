package lxs

import (
	"strings"
	"unicode/utf8"
)

// originForm reduces an absolute-form request-target (scheme://authority/path?query) to origin
// form, so "GET http://host/.env" cannot sidestep decoy matching. Any other target is returned as
// is (an empty one becomes "/").
func originForm(target string) string {
	if target == "" {
		return "/"
	}
	if target[0] == '/' {
		return target
	}
	// scheme = [A-Za-z][A-Za-z0-9+.-]*, then "://", then the authority up to / ? or #.
	c := target[0]
	if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
		return target
	}
	i := 1
	for i < len(target) {
		c = target[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-' {
			i++
			continue
		}
		break
	}
	if !strings.HasPrefix(target[i:], "://") {
		return target
	}
	i += 3
	for i < len(target) && target[i] != '/' && target[i] != '?' && target[i] != '#' {
		i++
	}
	rest := target[i:]
	// JavaScript's '.' (used by the Node SDK's regex) stops at line terminators; HTTP targets never
	// contain them, so the whole remainder is the path and query.
	if strings.HasPrefix(rest, "/") {
		return rest
	}
	return "/" + rest
}

// matchPath derives the path decoys are matched against: cut at the first '?', percent-decode once
// as UTF-8 (all or nothing: an invalid escape or invalid UTF-8 keeps the raw string), and drop one
// trailing '/' from paths longer than one character. Nothing else is normalised.
func matchPath(target string) string {
	p := target
	if q := strings.IndexByte(p, '?'); q >= 0 {
		p = p[:q]
	}
	if strings.IndexByte(p, '%') >= 0 {
		if d, ok := decodeURIComponent(p); ok {
			p = d
		}
	}
	if len(p) > 1 && p[len(p)-1] == '/' {
		p = p[:len(p)-1]
	}
	return p
}

// decodeURIComponent mirrors JavaScript's decodeURIComponent on a byte string: every %XX escape is
// decoded (including %2F and %25), each run of escapes must be valid UTF-8, and any invalid escape
// fails the whole decode. Unescaped bytes are copied as they are.
func decodeURIComponent(s string) (string, bool) {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); {
		if s[i] != '%' {
			b = append(b, s[i])
			i++
			continue
		}
		start := len(b)
		for i < len(s) && s[i] == '%' {
			if i+2 >= len(s) {
				return "", false
			}
			hi, ok1 := unhex(s[i+1])
			lo, ok2 := unhex(s[i+2])
			if !ok1 || !ok2 {
				return "", false
			}
			b = append(b, hi<<4|lo)
			i += 3
		}
		if !utf8.Valid(b[start:]) {
			return "", false
		}
	}
	return string(b), true
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

type decoyMatch struct {
	id   string
	path string
	pre  string // path + "/" for prefix decoys
}

// decoyMatcher: one map lookup for exact paths, a short prefix scan for web-admin sub-paths.
type decoyMatcher struct {
	exact    map[string]*decoyMatch
	prefixes []*decoyMatch
}

func newDecoyMatcher(decoys []resolvedDecoy) *decoyMatcher {
	m := &decoyMatcher{exact: map[string]*decoyMatch{}}
	for _, d := range decoys {
		dm := &decoyMatch{id: d.id, path: d.path}
		m.exact[d.path] = dm
		if d.prefix {
			dm.pre = d.path + "/"
			m.prefixes = append(m.prefixes, dm)
		}
	}
	return m
}

func (m *decoyMatcher) size() int { return len(m.exact) }

func (m *decoyMatcher) match(path string) *decoyMatch {
	if d, ok := m.exact[path]; ok {
		return d
	}
	for _, d := range m.prefixes {
		if strings.HasPrefix(path, d.pre) {
			return d
		}
	}
	return nil
}

type assetEntry struct {
	base     string
	name     string
	critical bool
}

// assetMatcher: longest pattern wins; "/x/*" and "/x" both match /x and its sub-paths.
type assetMatcher struct{ assets []assetEntry }

func (m *assetMatcher) match(path string) *assetEntry {
	for i := range m.assets {
		a := &m.assets[i]
		if path == a.base || strings.HasPrefix(path, a.base+"/") {
			return a
		}
	}
	return nil
}
