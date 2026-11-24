package lxs

// ConfigError is returned when a configuration is invalid. Code is stable and matches the Node
// SDK's LXSConfigError codes (E_OPTIONS, E_TRUST_PROXY, E_MOUNT_INVALID, ...); Hint, when set,
// says how to fix it.
type ConfigError struct {
	Code    string
	Message string
	Hint    string
}

// Error formats the error the way the Node SDK does: "CODE: message hint".
func (e *ConfigError) Error() string {
	s := e.Code + ": " + e.Message
	if e.Hint != "" {
		s += " " + e.Hint
	}
	return s
}

func configErr(code, msg, hint string) *ConfigError {
	return &ConfigError{Code: code, Message: msg, Hint: hint}
}
