package lxs

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// clientAddr is the derived client address: addr when it parses, raw otherwise (an unusual
// RemoteAddr such as a pipe name is reported as is and never matches a list).
type clientAddr struct {
	addr netip.Addr
	raw  string
}

func (c clientAddr) String() string {
	if c.addr.IsValid() {
		return c.addr.String()
	}
	return c.raw
}

func addrOf(s string) clientAddr {
	if a, ok := parseIP(s); ok {
		return clientAddr{addr: a}
	}
	return clientAddr{raw: s}
}

// socketAddr is the TCP peer address from r.RemoteAddr ("ip:port" or "[ip]:port").
func socketAddr(r *http.Request) string {
	ra := r.RemoteAddr
	if host, _, err := net.SplitHostPort(ra); err == nil {
		return host
	}
	return ra
}

// jsTrim trims what String.prototype.trim does for Latin-1 text (Node decodes headers as Latin-1).
func jsTrim(s string) string {
	isWS := func(c byte) bool {
		return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r' || c == 0xA0
	}
	i, j := 0, len(s)
	for i < j && isWS(s[i]) {
		i++
	}
	for j > i && isWS(s[j-1]) {
		j--
	}
	return s[i:j]
}

// forwardedFor returns the X-Forwarded-For entries (all header lines joined with ','), trimmed,
// IPv4-mapped entries unmapped, at most the last 64.
func forwardedFor(r *http.Request) []string {
	lines := r.Header.Values("X-Forwarded-For")
	var text string
	switch len(lines) {
	case 0:
		return nil
	case 1:
		text = lines[0]
	default:
		text = strings.Join(lines, ",")
	}
	if text == "" {
		return nil
	}
	hops := strings.Split(text, ",")
	for i, h := range hops {
		hops[i] = stripMapped(jsTrim(h))
	}
	if len(hops) > 64 {
		hops = hops[len(hops)-64:]
	}
	return hops
}

func validIP(s string) bool {
	_, ok := parseIP(s)
	return ok
}

// clientIP derives the client address per SPEC.md section 2.4. X-Forwarded-For entries left of
// the trusted hops are never read: the client wrote them.
func (m *Middleware) clientIP(r *http.Request) clientAddr {
	sock := stripMapped(socketAddr(r))
	if m.cfg.hops > 0 {
		hops := forwardedFor(r)
		client := sock
		for k := 1; k <= m.cfg.hops && len(hops)-k >= 0; k++ {
			h := hops[len(hops)-k]
			if !validIP(h) {
				return addrOf(sock)
			}
			client = h
		}
		return addrOf(client)
	}
	if m.cfg.trusted == nil {
		return addrOf(sock)
	}
	sa := addrOf(sock)
	if !m.cfg.trusted.contains(sa.addr) {
		return sa
	}
	hops := forwardedFor(r)
	if len(hops) == 0 {
		return sa
	}
	for i := len(hops) - 1; i >= 0; i-- {
		a, ok := parseIP(hops[i])
		if !ok {
			return sa
		}
		if !m.cfg.trusted.contains(a) {
			return clientAddr{addr: a}
		}
	}
	// Every entry is one of our proxies: the leftmost is the furthest one we can vouch for.
	return addrOf(hops[0])
}
