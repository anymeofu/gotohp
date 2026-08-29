//go:build server

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
)

func TestCheckBasicAuth(t *testing.T) {
	tests := []struct {
		name         string
		setAuth      bool
		user, pass   string
		wantUsername string
		wantPassword string
		want         bool
	}{
		{
			name:         "correct credentials",
			setAuth:      true,
			user:         "admin",
			pass:         "secret",
			wantUsername: "admin",
			wantPassword: "secret",
			want:         true,
		},
		{
			name:         "wrong password",
			setAuth:      true,
			user:         "admin",
			pass:         "wrong",
			wantUsername: "admin",
			wantPassword: "secret",
			want:         false,
		},
		{
			name:         "wrong username",
			setAuth:      true,
			user:         "someone-else",
			pass:         "secret",
			wantUsername: "admin",
			wantPassword: "secret",
			want:         false,
		},
		{
			name:         "missing header",
			setAuth:      false,
			wantUsername: "admin",
			wantPassword: "secret",
			want:         false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.setAuth {
				req.SetBasicAuth(tt.user, tt.pass)
			}

			got := checkBasicAuth(req, tt.wantUsername, tt.wantPassword)
			if got != tt.want {
				t.Errorf("checkBasicAuth() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestServerAuthMiddleware_Unconfigured(t *testing.T) {
	t.Setenv(serverBasicAuthEnvUsername, "")
	t.Setenv(serverBasicAuthEnvPassword, "")

	mw := serverAuthMiddleware()
	if mw != nil {
		t.Fatalf("expected nil middleware when both env vars are unset, got non-nil")
	}
}

func TestServerAuthMiddleware_ConfiguredGatesRequests(t *testing.T) {
	t.Setenv(serverBasicAuthEnvUsername, "admin")
	t.Setenv(serverBasicAuthEnvPassword, "secret")

	mw := serverAuthMiddleware()
	if mw == nil {
		t.Fatal("expected non-nil middleware when both env vars are set")
	}

	handlerCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	})
	handler := mw(next)

	// Unauthenticated request -> 401 with WWW-Authenticate header, next not called.
	handlerCalled = false
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated request: got status %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if got := rec.Header().Get("WWW-Authenticate"); got != `Basic realm="gotohp"` {
		t.Errorf("WWW-Authenticate header = %q, want %q", got, `Basic realm="gotohp"`)
	}
	if handlerCalled {
		t.Error("next handler should not be called for unauthenticated request")
	}

	// Authenticated request -> passes through to next handler.
	handlerCalled = false
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.SetBasicAuth("admin", "secret")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("authenticated request: got status %d, want %d", rec.Code, http.StatusOK)
	}
	if !handlerCalled {
		t.Error("next handler should be called for authenticated request")
	}
}

// TestHelperProcess_HalfConfiguredAuth is not a real test; it's invoked as a
// subprocess by TestServerAuthMiddleware_RequiresBothVars to exercise the
// log.Fatal path (which calls os.Exit and so cannot run in-process).
func TestHelperProcess_HalfConfiguredAuth(t *testing.T) {
	if os.Getenv("GOTOHP_TEST_HALF_CONFIGURED_AUTH") != "1" {
		return
	}
	serverAuthMiddleware()
}

// TestServerAuthMiddleware_RequiresBothVars verifies that setting only one of
// the two env vars fails loudly at startup (log.Fatal / non-zero exit),
// rather than silently running unprotected or silently ignoring the
// half-configured value.
func TestServerAuthMiddleware_RequiresBothVars(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess_HalfConfiguredAuth")
	cmd.Env = append(os.Environ(),
		"GOTOHP_TEST_HALF_CONFIGURED_AUTH=1",
		serverBasicAuthEnvUsername+"=admin",
		serverBasicAuthEnvPassword+"=",
	)
	out, err := cmd.CombinedOutput()

	exitErr, ok := err.(*exec.ExitError)
	if !ok || exitErr.Success() {
		t.Fatalf("expected process to exit non-zero via log.Fatal, err=%v, output=%s", err, out)
	}
}
