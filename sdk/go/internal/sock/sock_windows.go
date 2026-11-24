//go:build windows

package sock

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Windows named pipes, using only the standard library: CreateFile/CreateNamedPipe with
// FILE_FLAG_OVERLAPPED, then os.NewFile, which (Go 1.25+) associates the handle with the runtime's
// I/O completion port so reads and writes do not block threads and deadlines work.

func path(runDir, name string) string {
	h := sha1.Sum([]byte(runDir))
	return `\\.\pipe\lxs-` + hex.EncodeToString(h[:])[:8] + "-" + name
}

// RunDirPresent is always true on Windows: the pipes do not live in the run directory.
func RunDirPresent(string) bool { return true }

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procCreateNamedPipeW    = kernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe    = kernel32.NewProc("ConnectNamedPipe")
	procWaitNamedPipeW      = kernel32.NewProc("WaitNamedPipeW")
	procCreateEventW        = kernel32.NewProc("CreateEventW")
	procGetOverlappedResult = kernel32.NewProc("GetOverlappedResult")
)

const (
	errorPipeBusy       syscall.Errno = 231
	errorPipeConnected  syscall.Errno = 535
	errorNoData         syscall.Errno = 232
	errorOperationAbort syscall.Errno = 995

	pipeAccessDuplex        = 0x3
	fileFlagFirstPipeInst   = 0x00080000
	pipeTypeByte            = 0x0
	pipeReadmodeByte        = 0x0
	pipeWait                = 0x0
	pipeRejectRemoteClients = 0x8
	pipeUnlimitedInstances  = 255
	securitySqosPresent     = 0x00100000
	securityAnonymous       = 0x0
	waitObject0             = 0
	waitTimeout             = 0x102
	invalidHandle           = ^uintptr(0)
	pipeBufferSize          = 64 * 1024
	acceptPollInterval      = 50 // ms
	busyWaitInterval        = 50 // ms
)

type pipeAddr string

func (a pipeAddr) Network() string { return "pipe" }
func (a pipeAddr) String() string  { return string(a) }

// conn adapts an overlapped pipe handle wrapped in *os.File to net.Conn.
type conn struct {
	f    *os.File
	addr pipeAddr
}

func (c *conn) Read(b []byte) (int, error) {
	n, err := c.f.Read(b)
	if err != nil && isBrokenPipe(err) {
		return n, io.EOF
	}
	return n, err
}

func (c *conn) Write(b []byte) (int, error)        { return c.f.Write(b) }
func (c *conn) Close() error                       { return c.f.Close() }
func (c *conn) LocalAddr() net.Addr                { return c.addr }
func (c *conn) RemoteAddr() net.Addr               { return c.addr }
func (c *conn) SetDeadline(t time.Time) error      { return c.f.SetDeadline(t) }
func (c *conn) SetReadDeadline(t time.Time) error  { return c.f.SetReadDeadline(t) }
func (c *conn) SetWriteDeadline(t time.Time) error { return c.f.SetWriteDeadline(t) }

func isBrokenPipe(err error) bool {
	return errors.Is(err, syscall.ERROR_BROKEN_PIPE) || errors.Is(err, errorNoData)
}

func newConn(h syscall.Handle, addr string) net.Conn {
	return &conn{f: os.NewFile(uintptr(h), addr), addr: pipeAddr(addr)}
}

// Dial connects to a named pipe, waiting while every instance is busy.
func Dial(ctx context.Context, addr string) (net.Conn, error) {
	name, err := syscall.UTF16PtrFromString(addr)
	if err != nil {
		return nil, err
	}
	for {
		h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil,
			syscall.OPEN_EXISTING, syscall.FILE_FLAG_OVERLAPPED|securitySqosPresent|securityAnonymous, 0)
		if err == nil {
			return newConn(h, addr), nil
		}
		if !errors.Is(err, errorPipeBusy) {
			return nil, &net.OpError{Op: "dial", Net: "pipe", Addr: pipeAddr(addr), Err: err}
		}
		if ctx.Err() != nil {
			return nil, &net.OpError{Op: "dial", Net: "pipe", Addr: pipeAddr(addr), Err: ctx.Err()}
		}
		_, _, _ = procWaitNamedPipeW.Call(uintptr(unsafe.Pointer(name)), busyWaitInterval)
	}
}

// Listener serves a named pipe. It always keeps one unconnected instance open so clients never see
// the pipe missing between Accept calls.
type Listener struct {
	addr      string
	name      *uint16
	mu        sync.Mutex
	next      syscall.Handle
	closed    bool
	accepting bool
}

func createInstance(name *uint16, first bool) (syscall.Handle, error) {
	mode := uintptr(pipeAccessDuplex | syscall.FILE_FLAG_OVERLAPPED)
	if first {
		mode |= fileFlagFirstPipeInst
	}
	r, _, e := procCreateNamedPipeW.Call(uintptr(unsafe.Pointer(name)), mode,
		pipeTypeByte|pipeReadmodeByte|pipeWait|pipeRejectRemoteClients,
		pipeUnlimitedInstances, pipeBufferSize, pipeBufferSize, 0, 0)
	if r == invalidHandle {
		return 0, e
	}
	return syscall.Handle(r), nil
}

// Listen creates the first instance of a named pipe.
func Listen(addr string) (net.Listener, error) {
	name, err := syscall.UTF16PtrFromString(addr)
	if err != nil {
		return nil, err
	}
	h, err := createInstance(name, true)
	if err != nil {
		return nil, &net.OpError{Op: "listen", Net: "pipe", Addr: pipeAddr(addr), Err: err}
	}
	return &Listener{addr: addr, name: name, next: h}, nil
}

func (l *Listener) Addr() net.Addr { return pipeAddr(l.addr) }

// Close stops accepting; a blocked Accept returns net.ErrClosed shortly after.
func (l *Listener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	if !l.accepting && l.next != 0 {
		_ = syscall.CloseHandle(l.next)
		l.next = 0
	}
	return nil
}

func (l *Listener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, net.ErrClosed
	}
	l.accepting = true
	h := l.next
	l.mu.Unlock()

	err := l.connect(h)

	l.mu.Lock()
	defer l.mu.Unlock()
	l.accepting = false
	if err != nil || l.closed {
		_ = syscall.CloseHandle(h)
		l.next = 0
		if l.closed {
			return nil, net.ErrClosed
		}
		return nil, &net.OpError{Op: "accept", Net: "pipe", Addr: pipeAddr(l.addr), Err: err}
	}
	next, nerr := createInstance(l.name, false)
	if nerr != nil {
		l.next = 0
		l.closed = true
	} else {
		l.next = next
	}
	return newConn(h, l.addr), nil
}

// connect waits for a client on h, polling so Close can interrupt it.
func (l *Listener) connect(h syscall.Handle) error {
	ev, _, e := procCreateEventW.Call(0, 1, 0, 0)
	if ev == 0 {
		return e
	}
	defer syscall.CloseHandle(syscall.Handle(ev))
	ov := new(syscall.Overlapped)
	ov.HEvent = syscall.Handle(ev)
	r, _, e := procConnectNamedPipe.Call(uintptr(h), uintptr(unsafe.Pointer(ov)))
	if r != 0 {
		return nil
	}
	switch e {
	case errorPipeConnected:
		return nil
	case syscall.ERROR_IO_PENDING:
	default:
		return e
	}
	for {
		s, _ := syscall.WaitForSingleObject(syscall.Handle(ev), acceptPollInterval)
		if s == waitObject0 {
			break
		}
		if s != waitTimeout {
			return errors.New("pipe: wait failed")
		}
		l.mu.Lock()
		closed := l.closed
		l.mu.Unlock()
		if closed {
			_ = syscall.CancelIoEx(h, ov)
			_, _ = syscall.WaitForSingleObject(syscall.Handle(ev), syscall.INFINITE)
			runtime.KeepAlive(ov)
			return errorOperationAbort
		}
	}
	var n uint32
	r, _, e = procGetOverlappedResult.Call(uintptr(h), uintptr(unsafe.Pointer(ov)), uintptr(unsafe.Pointer(&n)), 0)
	runtime.KeepAlive(ov)
	if r == 0 {
		return e
	}
	return nil
}
