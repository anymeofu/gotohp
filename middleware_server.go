//go:build server

package main

import (
	"crypto/subtle"
	"net/http"
	"os"
)

// serverAccessTokenEnv is the env var used to opt in to access-token
// protection in server mode. Server mode (built with -tags server) is
// intended to be reachable over the public internet (e.g. behind nginx+SSL
// on a VPS), so unlike desktop mode -- a single trusted local user -- it
// needs its own gate.
//
// Transport is HTTP Basic Auth (so browsers show a native login prompt with
// no extra frontend work), but only a single token is checked -- same shape
// as the Cloudflare Worker rewrite's APP_ACCESS_TOKEN bearer gate, not a
// username+password pair. The browser's login prompt still asks for both
// fields; the username is ignored, only what's typed as the password needs
// to match the token.
const serverAccessTokenEnv = "GOTOHP_ACCESS_TOKEN"

// serverAuthMiddleware builds the access-token middleware for server mode,
// wired into application.Options.Assets.Middleware so it wraps the whole
// AssetServer request chain (the static frontend AND the Wails RPC binding
// calls the frontend makes).
//
// If GOTOHP_ACCESS_TOKEN is unset, no auth is applied (backward compatible
// default).
func serverAuthMiddleware() func(http.Handler) http.Handler {
	token := os.Getenv(serverAccessTokenEnv)
	if token == "" {
		return nil
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !checkAccessToken(r, token) {
				w.Header().Set("WWW-Authenticate", `Basic realm="gotohp"`)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// checkAccessToken validates the request's Basic Auth password field against
// the configured token using a constant-time comparison to avoid timing
// attacks. The username field is ignored entirely.
func checkAccessToken(r *http.Request, wantToken string) bool {
	_, gotPassword, ok := r.BasicAuth()
	if !ok {
		return false
	}

	return subtle.ConstantTimeCompare([]byte(gotPassword), []byte(wantToken)) == 1
}
