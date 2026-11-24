// Package sock locates and connects to the LXS sidecar sockets: Unix sockets in the shared run
// directory on Linux and macOS, Windows named pipes (local development only) on Windows. The pipe
// names match the Node SDK's, so a Go app and a Node fake agent interoperate.
package sock

// WebPath is where ds-web (the decoy server) listens.
func WebPath(runDir string) string { return path(runDir, "web") }

// AgentPath is where ds-agent (policy and signals) listens.
func AgentPath(runDir string) string { return path(runDir, "agent") }
