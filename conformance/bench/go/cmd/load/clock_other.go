//go:build !windows

package main

import "time"

type stamp = time.Time

func now() stamp { return time.Now() }

func since(s stamp) time.Duration { return time.Since(s) }
