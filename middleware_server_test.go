//go:build server

package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckAccessToken(t *testing.T) {
	tests := []struct {
		name       string
		setAuth    bool
		user, pass string
		wantToken  string
		want       bool
	}{
		{
			name:      "correct token, empty username",
			setAuth:   true,
			user:      "",
			pass:      "secret",
			wantToken: "secret",
			want:      true,
		},
		{
			name:      "correct token, any username is ignored",
			setAuth:   true,
			user:      "whatever",
			pass:      "secret",
			wantToken: "secret",
			want:      true,
		},
		{
			name:      "wrong token",
			setAuth:   true,
			user:      "",
			pass:      "wrong",
			wantToken: "secret",
			want:      false,
		},
		{
			name:      "missing header",
			setAuth:   false,
			wantToken: "secret",
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.setAuth {
				req.SetBasicAuth(tt.user, tt.pass)
			}

			got := checkAccessToken(req, tt.wantToken)
			if got != tt.want {
				t.Errorf("checkAccessToken() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestServerAuthMiddleware_Unconfigured(t *testing.T) {
	t.Setenv(serverAccessTokenEnv, "")

	mw := serverAuthMiddleware()
	if mw != nil {
		t.Fatalf("expected nil middleware when token env var is unset, got non-nil")
	}
}

func TestServerAuthMiddleware_ConfiguredGatesRequests(t *testing.T) {
	t.Setenv(serverAccessTokenEnv, "secret")

	mw := serverAuthMiddleware()
	if mw == nil {
		t.Fatal("expected non-nil middleware when token env var is set")
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

	// Authenticated request (blank username, correct token as password) -> passes through.
	handlerCalled = false
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.SetBasicAuth("", "secret")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("authenticated request: got status %d, want %d", rec.Code, http.StatusOK)
	}
	if !handlerCalled {
		t.Error("next handler should be called for authenticated request")
	}
}
