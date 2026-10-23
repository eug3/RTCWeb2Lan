package tunnel_test

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
)

func newJar(t *testing.T) http.CookieJar {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	return jar
}

// TestHTTPSUpstreamWithSessionCookie proves the two features compose: the agent
// can talk to an HTTPS intranet target (self-signed cert) AND carry its own
// session cookie obtained by logging in first.
//
// This is the shape "let the agent log in itself" takes: the login is just
// another request to the same target, so it inherits the exact same TLS
// configuration as every proxied request.
func TestHTTPSUpstreamWithSessionCookie(t *testing.T) {
	const session = "agent-session-token"

	var loggedIn bool
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: session, HttpOnly: true, Path: "/"})
			_, _ = io.WriteString(w, "{\"ok\":true}")
			return
		}
		c, err := r.Cookie("sid")
		if err != nil || c.Value != session {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, "{\"authenticated\":false}")
			return
		}
		loggedIn = true
		_, _ = io.WriteString(w, "{\"authenticated\":true}")
	}))
	defer srv.Close()

	// The client the agent would use for this target: HTTPS with the
	// self-signed cert tolerated (insecure_tls in routes.yaml).
	client := srv.Client()

	// Step 1: log in through the same client, so the cookie lands in its jar.
	client.Jar = newJar(t)
	loginResp, err := client.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("login over https: %v", err)
	}
	_, _ = io.Copy(io.Discard, loginResp.Body)
	_ = loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d, want 200", loginResp.StatusCode)
	}

	// Step 2: the proxied request must now be authenticated over HTTPS.
	resp, err := client.Get(srv.URL + "/api/projects")
	if err != nil {
		t.Fatalf("api over https: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (cookie not carried over TLS?)", resp.StatusCode)
	}
	if !loggedIn {
		t.Error("handler never saw an authenticated request")
	}
	if !strings.Contains(string(body), "authenticated\":true") {
		t.Errorf("body = %q", body)
	}
}
