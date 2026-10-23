package tunnel_test

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
)

// The agent keeps one jar per target and rewrites the URL inside Transport.
// http.Client applies jar cookies using req.URL BEFORE Transport runs, so a
// request whose URL still carries the PUBLIC host never matches the jar entry
// stored for the intranet target. This reproduces that mismatch.
func TestJarDoesNotApplyWhenURLIsPublicHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc", Path: "/"})
			_, _ = io.WriteString(w, "ok")
			return
		}
		if c, err := r.Cookie("sid"); err == nil && c.Value == "abc" {
			_, _ = io.WriteString(w, "authed")
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	target, err := relay.ParseTarget(srv.URL, false, false)
	if err != nil {
		t.Fatalf("target: %v", err)
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Transport: target.Transport()}

	// Login is issued with the PUBLIC host, exactly as the agent does.
	loginReq, _ := http.NewRequest(http.MethodPost, "http://public.example.com/api/auth/login", nil)
	loginReq.Host = "public.example.com"
	resp, err := client.Do(loginReq)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	// The follow-up request also uses the public host.
	apiReq, _ := http.NewRequest(http.MethodGet, "http://public.example.com/api/projects", nil)
	apiReq.Host = "public.example.com"
	resp2, err := client.Do(apiReq)
	if err != nil {
		t.Fatalf("api: %v", err)
	}
	defer func() { _ = resp2.Body.Close() }()
	body, _ := io.ReadAll(resp2.Body)

	t.Logf("follow-up status=%d body=%q", resp2.StatusCode, body)
	if resp2.StatusCode == http.StatusOK {
		t.Log("jar applied correctly (unexpected)")
		return
	}
	t.Log("CONFIRMED: the jar does not apply because req.URL is the public host")
}

// Regression for the bug that made every tunnelled request look logged out:
// http.ReadRequest produces a RELATIVE req.URL (path only, host in req.Host),
// and http.Client applies the cookie jar by looking up jar.Cookies(req.URL).
// With no host in the URL the lookup always misses, so the agent jar never
// contributed a cookie — even right after a successful login over the tunnel.
func TestJarNeedsAbsoluteURL(t *testing.T) {
	jar, _ := cookiejar.New(nil)
	host, _ := url.Parse("http://sense.example.com/")
	jar.SetCookies(host, []*http.Cookie{{Name: "sid", Value: "abc", Path: "/"}})

	// Relative URL: no host, so the jar lookup misses (the old behaviour).
	rel, _ := url.Parse("/api/projects")
	if got := jar.Cookies(rel); len(got) != 0 {
		t.Fatalf("relative URL unexpectedly matched %d cookie(s)", len(got))
	}

	// Absolute URL: the jar lookup matches, which is what proxy() now ensures.
	abs, _ := url.Parse("http://sense.example.com/api/projects")
	if got := jar.Cookies(abs); len(got) != 1 {
		t.Fatalf("absolute URL matched %d cookie(s), want 1", len(got))
	}
}
