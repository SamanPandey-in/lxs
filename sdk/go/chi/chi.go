// Package lxschi mounts the LXS middleware in a chi router. chi middlewares are plain
// func(http.Handler) http.Handler, so this package has no dependencies beyond lxs:
//
//	r := chi.NewRouter()
//	r.Use(lxschi.Middleware(m)) // first, before any other middleware and routes
//
// chi runs Use middlewares before routing, so decoy paths never reach a route.
package lxschi

import (
	"net/http"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
)

// Middleware returns m.Handler as a chi middleware.
func Middleware(m *lxs.Middleware) func(http.Handler) http.Handler {
	return m.Handler
}
