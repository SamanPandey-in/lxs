package lxsyaml

import (
	"errors"
	"strings"
	"testing"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
)

const example = `# yaml-language-server: $schema=../../sdk/lxs/schema/lxs.schema.json
service: shop
mode: monitor
trustProxy: 1
allowlist: [192.0.2.0/24]
decoys:
  - type: web-admin
    path: /admin
    brand: Acme
    acceptCredentials: [[admin, admin]]
  - { type: web-bait, path: /.env }
  - { type: ssh, port: 2222 }
assets:
  - pattern: /api/payments/*
    critical: true
honeytokens:
  apiKey: { header: x-api-key, prefix: sk_live_ }
`

func TestParseExample(t *testing.T) {
	cfg, err := Parse([]byte(example), "lxs.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "monitor" || cfg.TrustProxy != 1 || len(cfg.Decoys) != 3 || cfg.Decoys[1].Path != "/.env" ||
		!cfg.Assets[0].Critical || cfg.Honeytokens.Prefix != "sk_live_" {
		t.Fatalf("%+v", cfg)
	}
	cfg.Disabled = true
	if _, err := lxs.New(cfg); err != nil {
		t.Fatal(err)
	}
}

// Messages copied from the Node SDK's loadYamlConfig.
func TestParseErrors(t *testing.T) {
	hint := " See sdk/lxs/schema/lxs.schema.json (add `# yaml-language-server: $schema=...` for editor checks)."
	cases := map[string]string{
		"trustProxy: true":         "E_CONFIG_INVALID: lxs.yaml: trustProxy: Invalid input." + hint,
		`allowlist: ["0.0.0.0/0"]`: "E_CONFIG_INVALID: lxs.yaml: allowlist.0: '0.0.0.0/0' matches every address and would disable blocking entirely; list your own scanners' ranges instead." + hint,
		"mode: x":                  `E_CONFIG_INVALID: lxs.yaml: mode: Invalid option: expected one of "monitor"|"enforce".` + hint,
		"foo: 1":                   `E_CONFIG_INVALID: lxs.yaml: (root): Unrecognized key: "foo".` + hint,
		"decoys:\n  - type: web-admin\n    path: /admin\n    bogus: 1": `E_CONFIG_INVALID: lxs.yaml: decoys.0: Unrecognized key: "bogus".` + hint,
		"decoys:\n  - type: nope":                                      "E_CONFIG_INVALID: lxs.yaml: decoys.0.type: Invalid discriminator value. Expected 'web-admin' | 'web-bait' | 'ssh' | 'redis' | 'postgres'." + hint,
		"trustProxy: 0":                                                "E_CONFIG_INVALID: lxs.yaml: trustProxy: trustProxy hop count must be at least 1 (use false for no proxy)." + hint,
		"decoys:\n  - {type: web-bait, path: /x}":                      "E_TEMPLATE_UNKNOWN: cannot infer a bait template from '/x'. Pass template: 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin'.",
		"decoys:\n  - {type: web-admin, path: admin}":                  "E_CONFIG_INVALID: lxs.yaml: decoys.0.path: web decoys mount on an absolute path starting with '/'." + hint,
	}
	for in, want := range cases {
		cfg, err := Parse([]byte(in), "lxs.yaml")
		if err == nil {
			cfg.Disabled = true
			_, err = lxs.New(cfg)
		}
		if err == nil || err.Error() != want {
			t.Errorf("%q:\n got %v\nwant %s", in, err, want)
		}
	}
	_, err := Parse([]byte(": :"), "lxs.yaml")
	var ce *lxs.ConfigError
	if !errors.As(err, &ce) || ce.Code != "E_CONFIG_INVALID" || !strings.Contains(err.Error(), "not valid YAML") {
		t.Errorf("bad yaml: %v", err)
	}
}
