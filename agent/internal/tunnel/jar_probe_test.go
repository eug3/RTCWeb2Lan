package tunnel_test

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"
)

// The agent caches one jar per target and builds a fresh http.Client per
// request. Confirm that pattern actually preserves a session cookie: if it
// does not, a login over the tunnel would never authenticate later requests.
func TestJarSurvivesFreshClientPerRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc", Path: "/"})
			_, _ = io.WriteString(w, "ok")
			return
		}
		c, err := r.Cookie("sid")
		if err != nil || c.Value != "abc" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, "authed")
	}))
	defer srv.Close()

	jar, _ := cookiejar.New(nil)
	target, _ := url.Parse(srv.URL)

	newClient := func() *http.Client { return &http.Client{Jar: jar} }

	resp, err := newClient().Post(srv.URL+"/api/auth/login", "application/json", nil)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	cookies := jar.Cookies(target)
	t.Logf("jar holds %d cookie(s): %v", len(cookies), cookies)
	if len(cookies) == 0 {
		t.Fatal("jar did not store the login cookie")
	}

	resp2, err := newClient().Get(srv.URL + "/api/projects")
	if err != nil {
		t.Fatalf("api: %v", err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp2.StatusCode)
	}
}
