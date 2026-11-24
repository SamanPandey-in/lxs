// Package lxsgin mounts the LXS middleware in a gin engine.
//
//	r := gin.New()
//	r.Use(lxsgin.Middleware(m)) // before registering any route
//
// gin runs global middleware after routing (for unmatched paths, through the 404 chain), so call
// Use before adding routes. For the strongest guarantee, wrap the whole engine instead:
// http.ListenAndServe(addr, m.Handler(r)).
package lxsgin

import (
	"github.com/gin-gonic/gin"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
)

// Middleware returns a gin handler that runs the LXS checks. Decoy paths and blocked clients are
// answered here and the rest of the chain is aborted.
func Middleware(m *lxs.Middleware) gin.HandlerFunc {
	return func(c *gin.Context) {
		handled, done := m.Process(c.Writer, c.Request)
		if handled {
			c.Abort()
			return
		}
		c.Next()
		if done != nil {
			done(c.Writer.Status())
		}
	}
}
