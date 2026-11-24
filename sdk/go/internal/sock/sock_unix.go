//go:build !windows

package sock

import (
	"context"
	"net"
	"os"
	"path/filepath"
)

func path(runDir, name string) string {
	return runDir + "/" + name + "/" + name + ".sock"
}

// Dial connects to a Unix socket.
func Dial(ctx context.Context, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", addr)
}

// Listen creates the socket's directory, removes a stale socket file and listens.
func Listen(addr string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(addr), 0o755); err != nil {
		return nil, err
	}
	_ = os.Remove(addr)
	return net.Listen("unix", addr)
}

// RunDirPresent reports whether the run directory exists. Without it the sidecars are not running
// and the middleware stays a no-op (the Node SDK does the same).
func RunDirPresent(runDir string) bool {
	_, err := os.Stat(runDir)
	return err == nil
}
