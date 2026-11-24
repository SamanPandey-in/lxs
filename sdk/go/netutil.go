package lxs

import (
	"net/netip"
	"strings"
)

// parseIP parses a plain IPv4 or IPv6 literal (no port, no brackets, no surrounding text). An IPv6
// zone is accepted and dropped. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d, also in hex) become
// IPv4, so one client has one identity. This mirrors the Node SDK's net.isIP-based parser.
func parseIP(s string) (netip.Addr, bool) {
	if s == "" {
		return netip.Addr{}, false
	}
	if i := strings.IndexByte(s, '%'); i >= 0 {
		// Node's isIPv6 accepts a zone of [0-9a-zA-Z-.:]+ and only on IPv6 literals.
		zone := s[i+1:]
		if zone == "" || !validZone(zone) {
			return netip.Addr{}, false
		}
		a, err := netip.ParseAddr(s[:i])
		if err != nil || !a.Is6() {
			return netip.Addr{}, false
		}
		return a.Unmap(), true
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

func validZone(z string) bool {
	for i := 0; i < len(z); i++ {
		c := z[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-' || c == '.' || c == ':') {
			return false
		}
	}
	return true
}

// CanonicalIP returns the canonical text form of an address: dotted IPv4, or RFC 5952 IPv6 (lower
// case, longest run of two or more zero groups compressed, the first on a tie). IPv4-mapped IPv6
// becomes IPv4 and a zone is dropped. ok is false if s is not a plain address literal.
func CanonicalIP(s string) (canonical string, ok bool) {
	a, ok := parseIP(s)
	if !ok {
		return "", false
	}
	return a.String(), true
}

// stripMapped turns "::ffff:a.b.c.d" into "a.b.c.d" when the tail is a valid IPv4 literal.
func stripMapped(s string) string {
	if strings.HasPrefix(s, "::ffff:") {
		if a, err := netip.ParseAddr(s[7:]); err == nil && a.Is4() {
			return s[7:]
		}
	}
	return s
}

// cidrSpec is a parsed 'addr' or 'addr/bits' with the mapped-IPv6 adjustment applied.
type cidrSpec struct {
	prefix   netip.Prefix
	hasSlash bool
}

// parseCIDRSpec parses 'addr' or 'addr/bits'. bits is 1 to 3 decimal digits, at most 32 for IPv4
// and 128 for IPv6. An IPv4-mapped IPv6 prefix (::ffff:a.b.c.d/96..128) is the IPv4 prefix with 96
// fewer bits; a shorter mapped prefix is invalid. Anything else is invalid: invalid entries are
// never widened into something that matches more.
func parseCIDRSpec(spec string) (cidrSpec, bool) {
	addr, bitsRaw, hasSlash := strings.Cut(spec, "/")
	if hasSlash && strings.IndexByte(bitsRaw, '/') >= 0 {
		return cidrSpec{}, false
	}
	base, ok := parseIP(addr)
	if !ok {
		return cidrSpec{}, false
	}
	writtenAsV6 := strings.IndexByte(addr, ':') >= 0
	max := 32
	if writtenAsV6 {
		max = 128
	}
	bits := max
	if hasSlash {
		if len(bitsRaw) < 1 || len(bitsRaw) > 3 {
			return cidrSpec{}, false
		}
		bits = 0
		for i := 0; i < len(bitsRaw); i++ {
			c := bitsRaw[i]
			if c < '0' || c > '9' {
				return cidrSpec{}, false
			}
			bits = bits*10 + int(c-'0')
		}
	}
	if bits > max {
		return cidrSpec{}, false
	}
	if writtenAsV6 && base.Is4() {
		if bits < 96 {
			return cidrSpec{}, false
		}
		bits -= 96
	}
	p, err := base.Prefix(bits)
	if err != nil {
		return cidrSpec{}, false
	}
	return cidrSpec{prefix: p, hasSlash: hasSlash}, true
}

// parseCIDR returns the prefix an allowlist/blocklist/trustProxy entry matches.
func parseCIDR(spec string) (netip.Prefix, bool) {
	c, ok := parseCIDRSpec(spec)
	return c.prefix, ok
}

// isMatchAll reports a valid CIDR with a prefix length of 0 (0.0.0.0/0, ::/0, ::ffff:0.0.0.0/96).
func isMatchAll(spec string) bool {
	c, ok := parseCIDRSpec(spec)
	return ok && c.hasSlash && c.prefix.Bits() == 0
}

var namedRanges = map[string][]string{
	"loopback":    {"127.0.0.0/8", "::1/128"},
	"uniquelocal": {"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"},
	"linklocal":   {"169.254.0.0/16", "fe80::/10"},
}

// ipSet is a list of prefixes. A nil *ipSet matches nothing.
type ipSet struct{ prefixes []netip.Prefix }

// buildIPSet builds a set from CIDRs, single addresses and (when named is true) the names
// loopback, uniquelocal and linklocal. Invalid entries are ignored. Returns nil for an empty set.
func buildIPSet(specs []string, named bool) *ipSet {
	var out []netip.Prefix
	for _, s := range specs {
		list := []string{s}
		if named {
			if n, ok := namedRanges[s]; ok {
				list = n
			}
		}
		for _, c := range list {
			if p, ok := parseCIDR(c); ok {
				out = append(out, p)
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return &ipSet{prefixes: out}
}

func (s *ipSet) contains(a netip.Addr) bool {
	if s == nil || !a.IsValid() {
		return false
	}
	for _, p := range s.prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
