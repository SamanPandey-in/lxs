// Package lxsecho mounts the LXS middleware in an Echo (v4) server. Register it with Pre so it runs
// before routing:
//
//	e := echo.New()
//	e.Pre(lxsecho.Middleware(m))
package lxsecho

import (
	"github.com/labstack/echo/v4"

	lxs "github.com/SamanPandey-in/lxs/sdk/go"
)

// Middleware returns an Echo middleware that runs the LXS checks. Decoy paths and blocked clients
// are answered here and never reach a route.
func Middleware(m *lxs.Middleware) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			handled, done := m.Process(c.Response(), c.Request())
			if handled {
				return nil
			}
			err := next(c)
			if done != nil {
				status := c.Response().Status
				if err != nil && !c.Response().Committed {
					if he, ok := err.(*echo.HTTPError); ok {
						status = he.Code
					} else {
						status = 500
					}
				}
				done(status)
			}
			return err
		}
	}
}
