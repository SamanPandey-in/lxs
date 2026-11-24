package runner

import (
	"io"
	"log"
	"log/slog"
)

var (
	quietLogger    = slog.New(slog.NewTextHandler(io.Discard, nil))
	quietStdLogger = log.New(io.Discard, "", 0)
)
