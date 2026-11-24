package lxs

import (
	"fmt"
	"log/slog"
	"math"
	"os"
	"regexp"
	"strings"
	"time"
)

// Config configures the middleware. The fields mirror lxs.yaml (see sdk/lxs/schema/lxs.schema.json)
// and the Node SDK's options; LoadYAML in package lxsyaml fills it from a file.
type Config struct {
	// Mode is "enforce" (default) or "monitor". Monitor never blocks; decoys work in both modes.
	Mode string
	// RunDir holds the sidecar sockets (<RunDir>/web/web.sock, <RunDir>/agent/agent.sock).
	// Default: $LXS_RUN_DIR, else /run/lxs.
	RunDir string
	// TrustProxy says how to read X-Forwarded-For:
	//   - nil or false: ignore it, the client is the TCP peer (default);
	//   - an integer 1..10: that many reverse proxies sit in front of the app;
	//   - a []string of CIDRs or the names "loopback", "uniquelocal", "linklocal": the trusted proxies.
	// true is rejected (E_TRUST_PROXY): the client controls the leftmost entry.
	TrustProxy any
	// Allowlist: clients (CIDRs or addresses) that are never blocked and never routed to decoys.
	// A /0 entry is rejected (E_OPTIONS).
	Allowlist []string
	// Disabled turns the middleware into a no-op. LXS_DISABLED=1 does the same.
	Disabled bool
	// Decoys declared for this service. Only web-admin and web-bait decoys affect the middleware;
	// network decoys (ssh, redis, postgres) are accepted so a whole lxs.yaml loads.
	Decoys []Decoy
	// Assets: paths whose access by a watchlisted client is reported (asset.access signals).
	Assets []Asset
	// Honeytokens: report requests that carry a planted API key (honeytoken.use signals).
	Honeytokens *Honeytokens
	// Logger receives rate-limited warnings (agent unreachable, ...). Default: slog.Default().
	Logger *slog.Logger

	// PollInterval is how often the policy is refreshed (default 2s). Tests may shorten it.
	PollInterval time.Duration
	// FlushInterval is how often signals are posted to ds-agent (default 500ms).
	FlushInterval time.Duration
	// DecoyTimeout bounds how long ds-web may take to answer (default 10s, then 504).
	DecoyTimeout time.Duration
}

// Decoy is one entry of lxs.yaml's decoys list.
type Decoy struct {
	// Type is "web-admin", "web-bait", "ssh", "redis" or "postgres".
	Type string
	// Path is the mount of a web decoy, e.g. "/admin" or "/.env".
	Path string
	// Port is the host port of a network decoy.
	Port int
	// ID defaults to <type>-<slug(path)> for web decoys.
	ID string
	// Template is the web-bait template; inferred from Path when empty.
	Template string
	// Hostname and Persona are only used to derive a default ssh decoy id.
	Hostname string
	Persona  string
}

// Asset is a declared asset ("/api/payments/*").
type Asset struct {
	Pattern  string
	Name     string
	Critical bool
}

// Honeytokens configures planted API-key detection.
type Honeytokens struct {
	// Header is "authorization" or "x-api-key".
	Header string
	// Prefix is the planted key prefix (2-32 chars of [A-Za-z0-9_-]).
	Prefix string
}

const maxTrustedHops = 10

type resolvedDecoy struct {
	id     string
	path   string
	prefix bool
}

type resolvedConfig struct {
	enforce     bool
	runDir      string
	disabled    bool
	hops        int
	trusted     *ipSet
	allow       *ipSet
	decoys      []resolvedDecoy
	assets      []assetEntry
	htHeader    string
	htPrefix    string
	logger      *slog.Logger
	poll, flush time.Duration
	decoyTTL    time.Duration
}

const trustProxyTrueMsg = "trustProxy: true is not supported: it makes the leftmost X-Forwarded-For entry the client " +
	"address, and the client controls that entry, so any attacker could pick their own IP " +
	"(evading blocks, or getting someone else blocked)."
const trustProxyTrueHint = "Use a hop count (trustProxy: 1 for one reverse proxy in front of the app) or list your proxies' " +
	"addresses (trustProxy: ['loopback'] or ['10.0.0.0/8'])."

var (
	idRe        = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	htPrefixRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{2,32}$`)
	mountBadRe  = regexp.MustCompile(`[?#*]`)
	slugRe      = regexp.MustCompile(`[^a-z0-9]+`)
	dotenvRe    = regexp.MustCompile(`(^|/)\.env([._-][a-z0-9]+)?$`)
	sshHostRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	reservedWeb = map[string]bool{"/": true, "/robots.txt": true, "/favicon.ico": true}
)

// issue is one validation problem: a dotted path ("allowlist.0") and a message, as zod reports it.
type issue struct{ path, msg string }

func joinIssues(list []issue, sep string) string {
	parts := make([]string, len(list))
	for i, x := range list {
		p := x.path
		if p == "" {
			p = "(value)"
		}
		parts[i] = p + sep + x.msg
	}
	return strings.Join(parts, "; ")
}

// trustProxyIssues validates TrustProxy and returns (hops, proxies, issues). true is reported as
// "Invalid input" here; New reports it earlier as E_TRUST_PROXY, as the Node SDK does.
func trustProxyIssues(v any) (int, []string, []issue) {
	invalid := []issue{{"trustProxy", "Invalid input"}}
	switch t := v.(type) {
	case nil:
		return 0, nil, nil
	case bool:
		if !t {
			return 0, nil, nil
		}
		return 0, nil, invalid
	case []string:
		var issues []issue
		for i, c := range t {
			path := fmt.Sprintf("trustProxy.%d", i)
			if _, named := namedRanges[c]; !named {
				if _, ok := parseCIDR(c); !ok {
					issues = append(issues, issue{path, fmt.Sprintf("invalid trustProxy entry '%s'", c)})
					continue
				}
			}
			if isMatchAll(c) {
				issues = append(issues, issue{path, fmt.Sprintf("'%s' trusts every address, which lets any client forge X-Forwarded-For; list your proxies' addresses instead", c)})
			}
		}
		return 0, t, issues
	case []any:
		list := make([]string, 0, len(t))
		for _, x := range t {
			s, ok := x.(string)
			if !ok {
				return 0, nil, invalid
			}
			list = append(list, s)
		}
		return trustProxyIssues(list)
	}
	n, isNum, isInt := toInt(v)
	if !isNum || !isInt {
		return 0, nil, invalid
	}
	switch {
	case n < 1:
		return 0, nil, []issue{{"trustProxy", "trustProxy hop count must be at least 1 (use false for no proxy)"}}
	case n > maxTrustedHops:
		return 0, nil, []issue{{"trustProxy", fmt.Sprintf("trustProxy hop count must be at most %d", maxTrustedHops)}}
	}
	return n, nil, nil
}

// optionIssues checks mode, trustProxy and allowlist the way the Node SDK's OptionsSchema does.
func optionIssues(mode string, trustProxy any, allowlist []string) (int, []string, []issue) {
	var issues []issue
	if mode != "" && mode != "enforce" && mode != "monitor" {
		issues = append(issues, issue{"mode", `Invalid option: expected one of "monitor"|"enforce"`})
	}
	hops, proxies, tp := trustProxyIssues(trustProxy)
	issues = append(issues, tp...)
	for i, a := range allowlist {
		path := fmt.Sprintf("allowlist.%d", i)
		if _, ok := parseCIDR(a); !ok {
			issues = append(issues, issue{path, fmt.Sprintf("invalid CIDR '%s'", a)})
		} else if isMatchAll(a) {
			issues = append(issues, issue{path, fmt.Sprintf("'%s' matches every address and would disable blocking entirely; list your own scanners' ranges instead", a)})
		}
	}
	return hops, proxies, issues
}

// toInt accepts Go integer and float kinds (JSON and YAML decoders produce both).
func toInt(v any) (n int, isNum bool, isInt bool) {
	var f float64
	switch t := v.(type) {
	case int:
		return t, true, true
	case int8:
		return int(t), true, true
	case int16:
		return int(t), true, true
	case int32:
		return int(t), true, true
	case int64:
		if t > math.MaxInt32 || t < math.MinInt32 {
			return int(math.MaxInt32), true, true
		}
		return int(t), true, true
	case uint:
		return clampU(uint64(t)), true, true
	case uint8:
		return int(t), true, true
	case uint16:
		return int(t), true, true
	case uint32:
		return clampU(uint64(t)), true, true
	case uint64:
		return clampU(t), true, true
	case float32:
		f = float64(t)
	case float64:
		f = t
	default:
		return 0, false, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, true, false
	}
	if f > math.MaxInt32 {
		return math.MaxInt32, true, true
	}
	if f < math.MinInt32 {
		return math.MinInt32, true, true
	}
	return int(f), true, true
}

func clampU(u uint64) int {
	if u > math.MaxInt32 {
		return math.MaxInt32
	}
	return int(u)
}

func slugify(s string) string {
	out := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(out) > 48 {
		out = out[:48]
	}
	if out == "" {
		return "root"
	}
	return out
}

func inferTemplate(path string) string {
	p := strings.ToLower(path)
	switch {
	case dotenvRe.MatchString(p):
		return "dotenv"
	case strings.HasSuffix(p, "/.git/config"):
		return "git-config"
	case strings.Contains(p, "wp-login"):
		return "wp-login"
	case strings.Contains(p, "phpmyadmin") || strings.Contains(p, "pma"):
		return "phpmyadmin"
	case strings.HasSuffix(p, ".sql") || strings.HasSuffix(p, ".sql.gz") || strings.Contains(p, "dump") || strings.Contains(p, "backup"):
		return "sql-dump"
	}
	return ""
}

var webBaitTemplates = map[string]bool{"dotenv": true, "sql-dump": true, "git-config": true, "wp-login": true, "phpmyadmin": true}

func validateWebMount(path string) error {
	if !strings.HasPrefix(path, "/") {
		return configErr("E_MOUNT_INVALID", fmt.Sprintf("'%s' must be an absolute path.", path), "Start it with '/'.")
	}
	if mountBadRe.MatchString(path) || strings.IndexFunc(path, isJSSpace) >= 0 || strings.Contains(path, "..") || strings.Contains(path, "//") {
		return configErr("E_MOUNT_INVALID",
			fmt.Sprintf("'%s' must not contain query strings, wildcards, whitespace, '..' or '//'.", path),
			"Web decoys match exact paths (web-admin also covers its sub-paths).")
	}
	if len([]rune(path)) > 200 {
		return configErr("E_MOUNT_INVALID", "path is longer than 200 characters.", "")
	}
	if len(path) > 1 && strings.HasSuffix(path, "/") {
		return configErr("E_MOUNT_INVALID", fmt.Sprintf("'%s' must not end with '/'.", path), "")
	}
	if reservedWeb[path] || strings.HasPrefix(path, "/health") {
		return configErr("E_MOUNT_RESERVED",
			fmt.Sprintf("'%s' is reserved (/, /robots.txt, /favicon.ico, /health*) and cannot be a decoy.", path),
			"Pick a path an attacker would probe, for example /admin or /.env.")
	}
	return nil
}

func resolveConfig(c Config) (*resolvedConfig, error) {
	if b, ok := c.TrustProxy.(bool); ok && b {
		return nil, configErr("E_TRUST_PROXY", trustProxyTrueMsg, trustProxyTrueHint)
	}
	mode := c.Mode
	if mode == "" {
		mode = "enforce"
	}
	hops, proxies, issues := optionIssues(c.Mode, c.TrustProxy, c.Allowlist)
	if len(issues) > 0 {
		return nil, configErr("E_OPTIONS", "invalid LXS options: "+joinIssues(issues, " ")+".", "")
	}

	runDir := c.RunDir
	if runDir == "" {
		runDir = os.Getenv("LXS_RUN_DIR")
	}
	if runDir == "" {
		runDir = "/run/lxs"
	}

	rc := &resolvedConfig{
		enforce:  mode == "enforce",
		runDir:   runDir,
		disabled: c.Disabled || os.Getenv("LXS_DISABLED") == "1",
		hops:     hops,
		allow:    buildIPSet(c.Allowlist, false),
		logger:   c.Logger,
		poll:     c.PollInterval,
		flush:    c.FlushInterval,
		decoyTTL: c.DecoyTimeout,
	}
	if proxies != nil {
		rc.trusted = buildIPSet(proxies, true)
	}
	if rc.logger == nil {
		rc.logger = slog.Default()
	}
	if rc.poll <= 0 {
		rc.poll = 2 * time.Second
	}
	if rc.flush <= 0 {
		rc.flush = 500 * time.Millisecond
	}
	if rc.decoyTTL <= 0 {
		rc.decoyTTL = 10 * time.Second
	}

	ids := map[string]bool{}
	mounts := map[string]bool{}
	ports := map[int]bool{}
	for _, d := range c.Decoys {
		id := d.ID
		label := d.Type
		switch d.Type {
		case "web-admin", "web-bait":
			if err := validateWebMount(d.Path); err != nil {
				return nil, err
			}
			label = d.Type + " " + d.Path
			if id == "" {
				id = d.Type + "-" + slugify(d.Path)
			}
			if d.Type == "web-bait" {
				t := d.Template
				if t == "" {
					t = inferTemplate(d.Path)
				}
				if t == "" {
					return nil, configErr("E_TEMPLATE_UNKNOWN",
						fmt.Sprintf("cannot infer a bait template from '%s'.", d.Path),
						"Pass template: 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin'.")
				}
				if !webBaitTemplates[t] {
					return nil, configErr("E_OPTIONS", fmt.Sprintf("%s: template Invalid option: expected one of \"dotenv\"|\"sql-dump\"|\"git-config\"|\"wp-login\"|\"phpmyadmin\".", label), "")
				}
			}
		case "ssh", "redis", "postgres":
			if d.Port < 1 || d.Port > 65535 {
				return nil, configErr("E_PORT_RANGE", fmt.Sprintf("port %d is outside 1-65535.", d.Port), "")
			}
			label = fmt.Sprintf("%s :%d", d.Type, d.Port)
			if id == "" {
				switch d.Type {
				case "ssh":
					host := d.Hostname
					if host == "" {
						host = "db-backup-01"
						if d.Persona == "web-server" {
							host = "web-01"
						}
					}
					if !sshHostRe.MatchString(host) {
						return nil, configErr("E_OPTIONS", label+": hostname hostname: lowercase letters, digits and dashes.", "")
					}
					id = "ssh-" + host
				default:
					id = fmt.Sprintf("%s-%d", d.Type, d.Port)
				}
			}
			if ports[d.Port] {
				return nil, configErr("E_PORT_COLLISION", fmt.Sprintf("host port %d is declared twice.", d.Port), "")
			}
			ports[d.Port] = true
		default:
			return nil, configErr("E_TYPE_UNKNOWN", fmt.Sprintf("unknown decoy type '%s'.", d.Type),
				"Use 'web-admin', 'web-bait', 'ssh', 'redis' or 'postgres'.")
		}
		if d.ID != "" && !idRe.MatchString(d.ID) {
			return nil, configErr("E_OPTIONS", label+": id ids are lowercase letters, digits and dashes (max 63).", "")
		}
		if ids[id] {
			return nil, configErr("E_ID_COLLISION", fmt.Sprintf("decoy id '%s' is used twice.", id), "Use id: to tell them apart.")
		}
		ids[id] = true
		if d.Type == "web-admin" || d.Type == "web-bait" {
			if mounts[d.Path] {
				return nil, configErr("E_MOUNT_COLLISION", fmt.Sprintf("'%s' is declared twice.", d.Path), "Use id: to tell them apart.")
			}
			mounts[d.Path] = true
			rc.decoys = append(rc.decoys, resolvedDecoy{id: id, path: d.Path, prefix: d.Type == "web-admin"})
		}
	}

	seenAssets := map[string]bool{}
	for _, a := range c.Assets {
		p := a.Pattern
		if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "?#") || strings.IndexFunc(p, isJSSpace) >= 0 {
			return nil, configErr("E_ASSET_PATTERN", fmt.Sprintf("asset pattern '%s' must be an absolute path.", p), "Example: '/api/payments/*'.")
		}
		if star := strings.IndexByte(p, '*'); star >= 0 && !(strings.HasSuffix(p, "/*") && star == len(p)-1) {
			return nil, configErr("E_ASSET_PATTERN", fmt.Sprintf("'%s': '*' is only allowed as a trailing '/*'.", p), "")
		}
		if seenAssets[p] {
			return nil, configErr("E_ASSET_DUPLICATE", fmt.Sprintf("asset '%s' is declared twice.", p), "")
		}
		seenAssets[p] = true
		base := strings.TrimSuffix(p, "/*")
		name := a.Name
		if name == "" {
			name = base
		}
		rc.assets = append(rc.assets, assetEntry{base: base, name: name, critical: a.Critical})
	}
	// Longest pattern wins.
	for i := 1; i < len(rc.assets); i++ {
		for j := i; j > 0 && len(rc.assets[j].base) > len(rc.assets[j-1].base); j-- {
			rc.assets[j], rc.assets[j-1] = rc.assets[j-1], rc.assets[j]
		}
	}

	if h := c.Honeytokens; h != nil && (h.Header != "" || h.Prefix != "") {
		if h.Header != "authorization" && h.Header != "x-api-key" {
			return nil, configErr("E_OPTIONS", `honeytokens: apiKey.header Invalid option: expected one of "authorization"|"x-api-key".`, "")
		}
		if !htPrefixRe.MatchString(h.Prefix) {
			return nil, configErr("E_OPTIONS", "honeytokens: apiKey.prefix prefix: 2-32 chars of [A-Za-z0-9_-].", "")
		}
		rc.htHeader = h.Header
		rc.htPrefix = h.Prefix
	}
	return rc, nil
}

// isJSSpace reports the characters JavaScript's \s and String.prototype.trim treat as whitespace.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
