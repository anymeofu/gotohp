//go:build server

package main

import (
	"crypto/subtle"
	"log"
	"net/http"
	"os"
)

// serverBasicAuthEnvUsername and serverBasicAuthEnvPassword are the env vars
// used to opt in to HTTP Basic Auth protection in server mode. Server mode
// (built with -tags server) is intended to be reachable over the public
// internet (e.g. behind nginx+SSL on a VPS), so unlike desktop mode -- a
// single trusted local user -- it needs its own gate.
const (
	serverBasicAuthEnvUsername = "GOTOHP_SERVER_USERNAME"
	serverBasicAuthEnvPassword = "GOTOHP_SERVER_PASSWORD"
)

// serverAuthMiddleware builds the HTTP Basic Auth middleware for server mode,
// wired into application.Options.Assets.Middleware so it wraps the whole
// AssetServer request chain (the static frontend AND the Wails RPC binding
// calls the frontend makes).
//
// If neither GOTOHP_SERVER_USERNAME nor GOTOHP_SERVER_PASSWORD is set, no
// auth is applied (backward compatible default). If only one is set, this
// fails loudly at startup rather than silently running unprotected or
// silently ignoring the half-configured value.
func serverAuthMiddleware() func(http.Handler) http.Handler {
	username := os.Getenv(serverBasicAuthEnvUsername)
	password := os.Getenv(serverBasicAuthEnvPassword)

	if username == "" && password == "" {
		return nil
	}
	if username == "" || password == "" {
		log.Fatalf(
			"%s and %s must both be set together to enable server-mode auth (or both left unset to disable it)",
			serverBasicAuthEnvUsername, serverBasicAuthEnvPassword,
		)
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !checkBasicAuth(r, username, password) {
				w.Header().Set("WWW-Authenticate", `Basic realm="gotohp"`)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// checkBasicAuth validates the request's Authorization header against the
// configured username/password using constant-time comparisons to avoid
// timing attacks.
func checkBasicAuth(r *http.Request, wantUsername, wantPassword string) bool {
	gotUsername, gotPassword, ok := r.BasicAuth()
	if !ok {
		return false
	}

	usernameMatch := subtle.ConstantTimeCompare([]byte(gotUsername), []byte(wantUsername)) == 1
	passwordMatch := subtle.ConstantTimeCompare([]byte(gotPassword), []byte(wantPassword)) == 1

	return usernameMatch && passwordMatch
}
