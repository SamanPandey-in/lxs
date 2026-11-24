//go:build windows

package main

import (
	"syscall"
	"time"
	"unsafe"
)

// Go's monotonic clock on Windows ticks at about 0.5 ms, too coarse for sub-millisecond latencies;
// QueryPerformanceCounter has sub-microsecond resolution.
var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	qpc      = kernel32.NewProc("QueryPerformanceCounter")
	qpf      = kernel32.NewProc("QueryPerformanceFrequency")
	freq     int64
)

func init() { _, _, _ = qpf.Call(uintptr(unsafe.Pointer(&freq))) }

type stamp int64

func now() stamp {
	var c int64
	_, _, _ = qpc.Call(uintptr(unsafe.Pointer(&c)))
	return stamp(c)
}

func since(s stamp) time.Duration {
	return time.Duration((int64(now()) - int64(s)) * int64(time.Second) / freq)
}
