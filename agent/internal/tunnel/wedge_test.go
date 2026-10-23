package tunnel_test

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
	"github.com/beijihu/easytier-web2lan/agent/internal/tunnel"
	"github.com/pion/webrtc/v4"
)

// newAgentPeer brings up a browser PeerConnection wired to a freshly built
// agent over loopback, returns once the connection is established. No STUN is
// used: both sides gather host candidates, which is enough for a loopback pair.
func newAgentPeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "{}")
	}))
	t.Cleanup(srv.Close)
	routes, err := relay.SingleRoute(srv.URL, false)
	if err != nil {
		t.Fatalf("route: %v", err)
	}

	browser, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("browser pc: %v", err)
	}
	t.Cleanup(func() { _ = browser.Close() })
	if _, err := browser.CreateDataChannel(tunnel.ChannelLabel, nil); err != nil {
		t.Fatalf("primary dc: %v", err)
	}
	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(browser)
	if err := browser.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local: %v", err)
	}
	<-gathered

	logger := log.New(io.Discard, "", 0)
	if v := os.Getenv("W2L_TEST_VERBOSE"); v != "" {
		logger = log.New(os.Stderr, "[agent-test] ", log.LstdFlags)
	}
	agent, err := tunnel.New(webrtc.Configuration{}, routes, nil, func(webrtc.ICECandidateInit) {}, logger)
	if err != nil {
		t.Fatalf("agent: %v", err)
	}
	t.Cleanup(func() { _ = agent.Close() })
	answerSDP, err := agent.HandleOffer(browser.LocalDescription().SDP)
	if err != nil {
		t.Fatalf("handle offer: %v", err)
	}
	if err := browser.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answerSDP}); err != nil {
		t.Fatalf("set remote: %v", err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for browser.ConnectionState() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatalf("not connected: %s", browser.ConnectionState())
		}
		time.Sleep(20 * time.Millisecond)
	}
	return browser
}

// exchangeOn opens a fresh DataChannel (as the browser does per request),
// sends the given payload fragmented at the DataChannel MTU, and waits for the
// response end marker. Returns true on success.
func exchangeOn(browser *webrtc.PeerConnection, payload []byte, timeout time.Duration) bool {
	const mtu = 16*1024 - 1
	dc, err := browser.CreateDataChannel(tunnel.ChannelLabel, nil)
	if err != nil {
		return false
	}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		return false
	}
	done := make(chan struct{})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if len(m.Data) == 0 {
			close(done)
		}
	})
	for off := 0; off < len(payload); off += mtu {
		end := off + mtu
		if end > len(payload) {
			end = len(payload)
		}
		if err := dc.Send(payload[off:end]); err != nil {
			return false
		}
		for dc.BufferedAmount() > 1<<20 {
			time.Sleep(2 * time.Millisecond)
		}
	}
	_ = dc.Send(nil)
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// TestNoChannelOpenWedge is the regression for the field bug where a fresh
// DataChannel would open but its first request fragment never arrived (pion
// drops the first message if OnMessage is registered after the read loop
// starts). Many channels are opened back-to-back and must all be served.
func TestNoChannelOpenWedge(t *testing.T) {
	browser := newAgentPeer(t)
	const n = 30
	const rounds = 3
	req := []byte("GET /small HTTP/1.1\r\nHost: a.example.com\r\n\r\n")
	for r := 0; r < rounds; r++ {
		var wg sync.WaitGroup
		var mu sync.Mutex
		fail := 0
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if !exchangeOn(browser, req, 6*time.Second) {
					mu.Lock()
					fail++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if fail > 0 {
			t.Errorf("round %d: %d/%d channels wedged", r, fail, n)
		}
	}
}

// TestConcurrentLargeAndSmall exercises mixed payload sizes on one connection:
// a slow large upload must not starve the other channels.
func TestConcurrentLargeAndSmall(t *testing.T) {
	browser := newAgentPeer(t)
	big := bytes.Repeat([]byte("x"), 400*1024)
	const n = 12
	var wg sync.WaitGroup
	var mu sync.Mutex
	fail := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var payload []byte
			if i%2 == 0 {
				payload = append([]byte("POST /big HTTP/1.1\r\nHost: a.example.com\r\nContent-Length: 409600\r\n\r\n"), big...)
			} else {
				payload = []byte("GET /small HTTP/1.1\r\nHost: a.example.com\r\n\r\n")
			}
			if !exchangeOn(browser, payload, 15*time.Second) {
				mu.Lock()
				fail++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if fail > 0 {
		t.Errorf("%d/%d mixed requests failed", fail, n)
	}
}
