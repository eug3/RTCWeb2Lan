package fdn_test

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/beijihu/easytier-web2lan/agent/internal/fdn"
	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
)

func testLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// newTarget runs a fake intranet service that echoes the path it saw.
func newTarget(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream-Path", r.URL.Path)
		w.Header().Set("X-Upstream-Host", r.Host)
		_, _ = io.WriteString(w, "upstream:"+r.URL.Path)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newFDN(routes *relay.RouteTable) *fdn.Server {
	return fdn.New(fdn.Options{Routes: routes, Logger: testLogger()})
}

// The fallback proxy replaces the host nginx vhost: a request the Service
// Worker did not intercept must still reach the intranet service.
func TestFallbackProxiesToIntranet(t *testing.T) {
	target := newTarget(t)
	routes, err := relay.NewTableForTest([]relay.RouteSpec{
		{Kind: "host", Host: "app.example.com", Target: target.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/api/thing", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	newFDN(routes).Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("X-Upstream-Path"); got != "/api/thing" {
		t.Errorf("upstream path = %q, want /api/thing", got)
	}
	if got := rec.Header().Get("X-Upstream-Host"); got != "app.example.com" {
		t.Errorf("upstream host = %q, want app.example.com (public Host preserved)", got)
	}
	if !strings.Contains(rec.Body.String(), "upstream:/api/thing") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

// A prefix rule strips its addressing marker before forwarding.
func TestFallbackStripsPrefixRule(t *testing.T) {
	target := newTarget(t)
	routes, err := relay.NewTableForTest([]relay.RouteSpec{
		{Kind: "prefix", Host: "app.example.com", Prefix: "/tunnel/app", Target: target.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/tunnel/app/api/x", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	newFDN(routes).Handler().ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Upstream-Path"); got != "/api/x" {
		t.Errorf("upstream path = %q, want /api/x (prefix stripped)", got)
	}
}

// Without a route table the node still serves assets + signaling, but must not
// pretend to proxy: an unmatched request is a clear 404.
func TestNoRoutesReturns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/anything", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	newFDN(nil).Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// An unknown host with a route table configured is a configuration error worth
// surfacing as 502, not a silent empty page.
func TestUnknownHostIsBadGateway(t *testing.T) {
	target := newTarget(t)
	routes, err := relay.NewTableForTest([]relay.RouteSpec{
		{Kind: "host", Host: "known.example.com", Target: target.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://other.example.com/x", nil)
	req.Host = "other.example.com"
	rec := httptest.NewRecorder()
	newFDN(routes).Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

// The signaling endpoint must be reachable under the overlay prefix. The
// signaling server mounts "/ws" internally, so the node has to strip the
// prefix; getting this wrong yields a 404 and every agent retry-loops.
func TestSignalingMountsUnderOverlayPrefix(t *testing.T) {
	srv := newFDN(nil)

	// A plain GET without websocket headers still proves routing: the
	// handler answers "missing room" (400) rather than 404, i.e. it ran.
	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/__lan/ws", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code == http.StatusNotFound {
		t.Fatalf("signaling not mounted at /__lan/ws (got 404)")
	}
}
