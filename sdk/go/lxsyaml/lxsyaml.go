// Package lxsyaml loads lxs.yaml (the language-neutral LXS config, schema in
// sdk/lxs/schema/lxs.schema.json) into an lxs.Config. It is a separate package so that the core
// lxs package stays standard-library only; this one adds a YAML parser.
package lxsyaml

import (
	"os"
	"path/filepath"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
	"go.yaml.in/yaml/v3"
)

// Parse parses lxs.yaml text. name is used in error messages. Errors are *lxs.ConfigError with
// code E_CONFIG_INVALID (bad YAML or shape) or the codes lxs.New uses.
func Parse(data []byte, name string) (lxs.Config, error) {
	var doc any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return lxs.Config{}, &lxs.ConfigError{Code: "E_CONFIG_INVALID", Message: name + " is not valid YAML: " + err.Error()}
	}
	var m map[string]any
	switch d := doc.(type) {
	case nil:
	case map[string]any:
		m = d
	default:
		return lxs.Config{}, &lxs.ConfigError{Code: "E_CONFIG_INVALID", Message: name + ": (root): Invalid input: expected object."}
	}
	return lxs.ConfigFromMap(m, name)
}

// LoadYAML reads an lxs.yaml file into an lxs.Config.
func LoadYAML(path string) (lxs.Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return lxs.Config{}, err
	}
	return Parse(data, filepath.Base(path))
}

// New reads an lxs.yaml file and builds the middleware:
//
//	m, err := lxsyaml.New("lxs.yaml")
//	http.ListenAndServe(":8080", m.Handler(app))
func New(path string) (*lxs.Middleware, error) {
	cfg, err := LoadYAML(path)
	if err != nil {
		return nil, err
	}
	return lxs.New(cfg)
}
