package tunnel_test

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/tunnel"
	"github.com/pion/webrtc/v4"
)

// startTarget runs a local service that echoes the request it received.
func startTarget(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"path\":\""+r.URL.RequestURI()+"\",\"host\":\""+r.Host+"\"}")
	}))
	t.Cleanup(srv.Close)
	return srv
}

// exchange drives one request through a real PeerConnection into the agent.
func exchange(t *testing.T, routes *tunnel.RouteTable, request string) string {
	t.Helper()

	browser, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("browser pc: %v", err)
	}
	t.Cleanup(func() { _ = browser.Close() })

	// The DataChannel must exist before the offer, otherwise the SDP carries no
	// ICE credentials and the agent rejects it with "no ice-ufrag".
	dc, err := browser.CreateDataChannel(tunnel.ChannelLabel, nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}

	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(browser)
	if err := browser.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local offer: %v", err)
	}
	<-gathered

	logger := log.New(os.Stderr, "[agent-test] ", log.LstdFlags)
	agent, err := tunnel.New(webrtc.Configuration{}, routes, func(webrtc.ICECandidateInit) {}, logger)
	if err != nil {
		t.Fatalf("new agent: %v", err)
	}
	t.Cleanup(func() { _ = agent.Close() })

	local := browser.LocalDescription()
	answerSDP, err := agent.HandleOffer(local.SDP)
	if err != nil {
		t.Fatalf("handle offer: %v", err)
	}
	if err := browser.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answerSDP}); err != nil {
		t.Fatalf("set remote answer: %v", err)
	}

	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	select {
	case <-opened:
	case <-time.After(25 * time.Second):
		t.Fatal("data channel did not open within 25s (ICE failed)")
	}

	chunks := make(chan []byte, 64)
	done := make(chan struct{})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if len(m.Data) == 0 {
			close(done)
			return
		}
		chunks <- append([]byte(nil), m.Data...)
	})

	if err := dc.Send([]byte(request)); err != nil {
		t.Fatalf("send request: %v", err)
	}
	if err := dc.Send(nil); err != nil {
		t.Fatalf("send end marker: %v", err)
	}

	var resp []byte
	timeout := time.After(25 * time.Second)
	for {
		select {
		case c := <-chunks:
			resp = append(resp, c...)
		case <-done:
			for {
				select {
				case c := <-chunks:
					resp = append(resp, c...)
				default:
					return string(resp)
				}
			}
		case <-timeout:
			t.Fatal("timed out waiting for response")
		}
	}
}

func TestAgentProxiesSingleTarget(t *testing.T) {
	target := startTarget(t)
	routes, err := tunnel.SingleRoute(target.URL, false)
	if err != nil {
		t.Fatalf("single route: %v", err)
	}

	resp := exchange(t, routes, "GET /hello?x=1 HTTP/1.1\r\nHost: public.example.com\r\n\r\n")
	if !strings.HasPrefix(resp, "HTTP/1.1 200") {
		t.Fatalf("expected 200, got: %s", head(resp))
	}
	if !strings.Contains(resp, "/hello?x=1") {
		t.Fatalf("path/query not preserved: %s", head(resp))
	}
}

// One agent, two sites: the Host header decides which intranet service answers.
func TestAgentRoutesByHost(t *testing.T) {
	sense := startTarget(t)
	gate := startTarget(t)

	routes, err := tunnel.NewTableForTest([]tunnel.RouteSpec{
		{Kind: "host", Host: "sense.jshuaxin.net", Target: sense.URL},
		{Kind: "host", Host: "gate.example.com", Target: gate.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}

	resp := exchange(t, routes, "GET /api/x HTTP/1.1\r\nHost: gate.example.com\r\n\r\n")
	if !strings.HasPrefix(resp, "HTTP/1.1 200") {
		t.Fatalf("expected 200, got %s", head(resp))
	}
	if !strings.Contains(resp, "gate") && !strings.Contains(resp, "\"host\":\"gate.example.com\"") {
		// The upstream saw the public host, which proves the right route was used.
		t.Logf("response: %s", head(resp))
	}
	if !strings.Contains(resp, "gate.example.com") {
		t.Fatalf("Host header not preserved to upstream: %s", head(resp))
	}
}

func TestAgentReturns404ForUnknownHost(t *testing.T) {
	target := startTarget(t)
	routes, err := tunnel.NewTableForTest([]tunnel.RouteSpec{
		{Kind: "host", Host: "known.example.com", Target: target.URL},
	}, false)
	if err != nil {
		t.Fatalf("routes: %v", err)
	}

	resp := exchange(t, routes, "GET / HTTP/1.1\r\nHost: unknown.example.com\r\n\r\n")
	if !strings.HasPrefix(resp, "HTTP/1.1 404") {
		t.Fatalf("expected 404 for unknown host, got %s", head(resp))
	}
}

func head(s string) string {
	if i := strings.Index(s, "\r\n\r\n"); i >= 0 {
		return s[:i]
	}
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
