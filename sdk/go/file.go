package lxs

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const fileHint = "See sdk/lxs/schema/lxs.schema.json (add `# yaml-language-server: $schema=...` for editor checks)."

var (
	serviceRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
	telDirRe  = regexp.MustCompile(`^[A-Za-z0-9._/~-]{1,256}$`)
)

var rootKeys = keyset("$schema", "service", "mode", "runDir", "trustProxy", "allowlist", "disabled", "telemetry", "decoys", "assets", "honeytokens")

var decoyKeys = map[string]map[string]bool{
	"web-admin": keyset("type", "path", "id", "brand", "acceptCredentials", "acceptAfter", "panel"),
	"web-bait":  keyset("type", "path", "id", "template", "breadcrumbs"),
	"ssh":       keyset("type", "port", "id", "persona", "hostname", "credentials", "banner"),
	"redis":     keyset("type", "port", "id", "seed", "requirePassword"),
	"postgres":  keyset("type", "port", "id", "seed", "requirePassword"),
}

var assetKeys = keyset("pattern", "name", "criticality", "critical")

func keyset(k ...string) map[string]bool {
	m := make(map[string]bool, len(k))
	for _, x := range k {
		m[x] = true
	}
	return m
}

func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	if _, ok, _ := toInt(v); ok {
		return "number"
	}
	return fmt.Sprintf("%T", v)
}

type fileChecker struct{ issues []issue }

func (c *fileChecker) add(path, msg string) { c.issues = append(c.issues, issue{path, msg}) }

func (c *fileChecker) expect(path, want string, v any) {
	c.add(path, fmt.Sprintf("Invalid input: expected %s, received %s", want, typeName(v)))
}

func (c *fileChecker) unknownKeys(path string, obj map[string]any, allowed map[string]bool) {
	var extra []string
	for k := range obj {
		if !allowed[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		c.add(path, fmt.Sprintf("Unrecognized key: %q", k))
	}
}

func (c *fileChecker) str(path string, obj map[string]any, key string) (string, bool) {
	v, ok := obj[key]
	if !ok {
		return "", false
	}
	s, isStr := v.(string)
	if !isStr {
		c.expect(join(path, key), "string", v)
		return "", false
	}
	return s, true
}

func (c *fileChecker) strList(path string, v any) []string {
	arr, ok := v.([]any)
	if !ok {
		c.expect(path, "array", v)
		return nil
	}
	out := make([]string, 0, len(arr))
	for i, x := range arr {
		s, ok := x.(string)
		if !ok {
			c.expect(fmt.Sprintf("%s.%d", path, i), "string", x)
			continue
		}
		out = append(out, s)
	}
	return out
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// ConfigFromMap converts a decoded lxs.yaml document (maps, slices, strings, numbers, booleans, as
// produced by a YAML or JSON decoder) into a Config. It checks the document's shape the way the Node
// SDK's lxs.yaml loader does (unknown keys, wrong types, mode/trustProxy/allowlist rules) and
// reports problems as E_CONFIG_INVALID; New then runs the remaining checks. name is used in
// messages (e.g. "lxs.yaml").
func ConfigFromMap(doc map[string]any, name string) (Config, error) {
	var cfg Config
	c := &fileChecker{}
	if doc == nil {
		doc = map[string]any{}
	}
	c.unknownKeys("", doc, rootKeys)
	c.str("", doc, "$schema")
	if s, ok := c.str("", doc, "service"); ok && !serviceRe.MatchString(s) {
		c.add("service", "must be a compose service name")
	}
	if s, ok := c.str("", doc, "runDir"); ok {
		if s == "" {
			c.add("runDir", "Too small: expected string to have >=1 characters")
		}
		cfg.RunDir = s
	}
	mode, _ := c.str("", doc, "mode")
	cfg.Mode = mode
	if v, ok := doc["disabled"]; ok {
		if b, isBool := v.(bool); isBool {
			cfg.Disabled = b
		} else {
			c.expect("disabled", "boolean", v)
		}
	}
	if v, ok := doc["trustProxy"]; ok {
		cfg.TrustProxy = v
	}
	if v, ok := doc["allowlist"]; ok {
		cfg.Allowlist = c.strList("allowlist", v)
	}
	_, _, opt := optionIssues(cfg.Mode, cfg.TrustProxy, cfg.Allowlist)
	c.issues = append(c.issues, opt...)

	if v, ok := doc["telemetry"]; ok {
		t, isObj := v.(map[string]any)
		if !isObj {
			c.expect("telemetry", "object", v)
		} else {
			c.unknownKeys("telemetry", t, keyset("dir", "sources"))
			if d, ok := c.str("telemetry", t, "dir"); !ok {
				if _, present := t["dir"]; !present {
					c.add("telemetry.dir", "Invalid input: expected string, received undefined")
				}
			} else if !telDirRe.MatchString(d) {
				c.add("telemetry.dir", "telemetry.dir: a host directory path of letters, digits and . _ / ~ -")
			}
			if s, ok := t["sources"]; ok {
				for i, x := range c.strList("telemetry.sources", s) {
					if x != "firewall" && x != "auth" {
						c.add(fmt.Sprintf("telemetry.sources.%d", i), `Invalid option: expected one of "firewall"|"auth"`)
					}
				}
			}
		}
	}

	if v, ok := doc["decoys"]; ok {
		arr, isArr := v.([]any)
		if !isArr {
			c.expect("decoys", "array", v)
		}
		for i, x := range arr {
			p := fmt.Sprintf("decoys.%d", i)
			obj, isObj := x.(map[string]any)
			if !isObj {
				c.expect(p, "object", x)
				continue
			}
			typ, _ := obj["type"].(string)
			allowed, known := decoyKeys[typ]
			if !known {
				c.add(p+".type", "Invalid discriminator value. Expected 'web-admin' | 'web-bait' | 'ssh' | 'redis' | 'postgres'")
				continue
			}
			c.unknownKeys(p, obj, allowed)
			d := Decoy{Type: typ}
			if typ == "web-admin" || typ == "web-bait" {
				path, ok := c.str(p, obj, "path")
				switch {
				case !ok:
					if _, present := obj["path"]; !present {
						c.add(p+".path", "Invalid input: expected string, received undefined")
					}
				case !strings.HasPrefix(path, "/"):
					c.add(p+".path", "web decoys mount on an absolute path starting with '/'")
				case len([]rune(path)) > 200:
					c.add(p+".path", "Too big: expected string to have <=200 characters")
				}
				d.Path = path
				d.Template, _ = c.str(p, obj, "template")
			} else {
				pv, present := obj["port"]
				n, isNum, isInt := toInt(pv)
				switch {
				case !present:
					c.add(p+".port", "Invalid input: expected number, received undefined")
				case !isNum:
					c.expect(p+".port", "number", pv)
				case !isInt:
					c.add(p+".port", "Invalid input: expected int, received number")
				case n < 1 || n > 65535:
					c.add(p+".port", "Host port out of range: expected 1-65535")
				}
				d.Port = n
				d.Hostname, _ = c.str(p, obj, "hostname")
				d.Persona, _ = c.str(p, obj, "persona")
			}
			d.ID, _ = c.str(p, obj, "id")
			cfg.Decoys = append(cfg.Decoys, d)
		}
	}

	if v, ok := doc["assets"]; ok {
		arr, isArr := v.([]any)
		if !isArr {
			c.expect("assets", "array", v)
		}
		for i, x := range arr {
			p := fmt.Sprintf("assets.%d", i)
			obj, isObj := x.(map[string]any)
			if !isObj {
				c.expect(p, "object", x)
				continue
			}
			c.unknownKeys(p, obj, assetKeys)
			a := Asset{}
			pat, ok := c.str(p, obj, "pattern")
			if ok && !strings.HasPrefix(pat, "/") {
				c.add(p+".pattern", "asset patterns are absolute paths")
			}
			a.Pattern = pat
			a.Name, _ = c.str(p, obj, "name")
			if crit, ok := c.str(p, obj, "criticality"); ok {
				a.Critical = crit == "critical"
			}
			if b, ok := obj["critical"].(bool); ok && b {
				if _, hasCrit := obj["criticality"]; !hasCrit {
					a.Critical = true
				}
			}
			cfg.Assets = append(cfg.Assets, a)
		}
	}

	if v, ok := doc["honeytokens"]; ok {
		switch t := v.(type) {
		case bool:
			if !t {
				c.add("honeytokens", "Invalid input")
			}
		case map[string]any:
			c.unknownKeys("honeytokens", t, keyset("apiKey", "canaryRows"))
			if ak, ok := t["apiKey"].(map[string]any); ok {
				h := &Honeytokens{}
				h.Header, _ = c.str("honeytokens.apiKey", ak, "header")
				h.Prefix, _ = c.str("honeytokens.apiKey", ak, "prefix")
				cfg.Honeytokens = h
			}
		default:
			c.add("honeytokens", "Invalid input")
		}
	}

	if len(c.issues) > 0 {
		parts := make([]string, len(c.issues))
		for i, x := range c.issues {
			p := x.path
			if p == "" {
				p = "(root)"
			}
			parts[i] = p + ": " + x.msg
		}
		return Config{}, configErr("E_CONFIG_INVALID", name+": "+strings.Join(parts, "; ")+".", fileHint)
	}
	return cfg, nil
}
