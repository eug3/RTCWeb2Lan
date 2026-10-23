package tunnel_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
)

// The browser relays the session cookie to document.cookie, so later tunneled
// requests DO carry a Cookie header. Confirm the agent forwards it upstream:
// if it were dropped, a login over the tunnel would still leave every later
// request unauthenticated.
func TestForwardsBrowserCookieHeader(t *testing.T) {
	var gotCookie string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCookie = r.Header.Get("Cookie")
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()

	target, err := relay.ParseTarget(srv.URL, false, false)
	if err != nil {
		t.Fatalf("target: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://public.example.com/api/projects", nil)
	req.Host = "public.example.com"
	req.RequestURI = "" // client requests must not carry a RequestURI
	req.Header.Set("Cookie", "gsdj_sense_admin=abc123")

	client := &http.Client{Transport: target.Transport()}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if !strings.Contains(gotCookie, "gsdj_sense_admin=abc123") {
		t.Errorf("upstream cookie = %q, want the browser's session cookie", gotCookie)
	}
}
