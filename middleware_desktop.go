//go:build !server

package main

import "net/http"

// serverAuthMiddleware is a no-op outside of server mode (desktop GUI and
// default/dev builds). Desktop mode is already implicitly trusted (a single
// local user), so it must never show a login prompt.
func serverAuthMiddleware() func(http.Handler) http.Handler {
	return nil
}
