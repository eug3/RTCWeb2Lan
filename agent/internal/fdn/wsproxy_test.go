package fdn_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/beijihu/easytier-web2lan/agent/internal/fdn"
	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
)

// Socket.IO and other realtime transports upgrade to websocket. The fallback
// must carry that upgrade through, otherwise the app's live updates break as
// soon as the tunnel is unavailable.
func TestFallbackForwardsWebSocketUpgrade(t *testing.T) {
	var gotUpgrade, gotConnection string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUpgrade = r.Header.Get("Upgrade")
		gotConnection = r.Header.Get("Connection")
		_, _ = io.WriteString(w, "ok")
	}))
	defer up.Close()

	routes, err := relay.NewTableForTest([]relay.RouteSpec{
		{Kind: "host", Host: "app.example.com", Target: up.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}
	srv := fdn.New(fdn.Options{Routes: routes})

	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/socket.io/?EIO=4&transport=websocket", nil)
	req.Host = "app.example.com"
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	t.Logf("upstream saw Upgrade=%q Connection=%q; response %d", gotUpgrade, gotConnection, rec.Code)
	if gotUpgrade == "" {
		t.Errorf("Upgrade header was not forwarded to the upstream")
	}
}

// The polling transport is a plain HTTP request and must work too.
func TestFallbackForwardsSocketIOPolling(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "0{}\n")
	}))
	defer up.Close()

	routes, err := relay.NewTableForTest([]relay.RouteSpec{
		{Kind: "host", Host: "app.example.com", Target: up.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}
	srv := fdn.New(fdn.Options{Routes: routes})

	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/socket.io/?EIO=4&transport=polling", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// The fallback must preserve the request path byte-for-byte, including a
// trailing slash. path.Join cleans it, turning "/socket.io/" into
// "/socket.io", and Socket.IO serves only the former — so the app's realtime
// channel 404s through the fallback while working when proxied by nginx.
func TestFallbackPreservesTrailingSlash(t *testing.T) {
	var gotPath, gotQuery string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		_, _ = io.WriteString(w, "ok")
	}))
	defer up.Close()

	routes, err := relay.NewTableForTest([]relay.RouteSpec{
		{Kind: "host", Host: "app.example.com", Target: up.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}
	srv := fdn.New(fdn.Options{Routes: routes})

	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/socket.io/?EIO=4&transport=polling", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if gotPath != "/socket.io/" {
		t.Errorf("upstream path = %q, want /socket.io/ (trailing slash preserved)", gotPath)
	}
	if gotQuery != "EIO=4&transport=polling" {
		t.Errorf("upstream query = %q, want EIO=4&transport=polling", gotQuery)
	}
}
