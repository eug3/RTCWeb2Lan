package signaling_test

import (
	"context"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/protocol"
	"github.com/beijihu/easytier-web2lan/agent/internal/signaling"
	"github.com/gorilla/websocket"
)

// TestRelayPairsAndForwards proves the relay pairs an agent and a browser in a
// room and forwards messages verbatim in both directions.
func TestRelayPairsAndForwards(t *testing.T) {
	logger := log.New(os.Stderr, "[relay-test] ", log.LstdFlags)
	srv := httptest.NewServer(signaling.NewServer(logger).Handler())
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?room=demo&role=agent"
	agent, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial agent: %v", err)
	}
	defer func() { _ = agent.Close() }()

	// Drain the relay status frame.
	_ = agent.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := agent.ReadMessage(); err != nil {
		t.Fatalf("read agent status: %v", err)
	}

	browser, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?room=demo&role=browser", nil)
	if err != nil {
		t.Fatalf("dial browser: %v", err)
	}
	defer func() { _ = browser.Close() }()

	// Browser sends an offer; the relay must hand it to the agent unchanged.
	offer := protocol.New(protocol.TypeOffer, "demo")
	offer.SDP = "v=0-fake-offer"
	payload, _ := protocol.Marshal(offer)
	if err := browser.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("browser send: %v", err)
	}

	var got protocol.Message
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_ = agent.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := agent.ReadMessage()
		if err != nil {
			break
		}
		m, err := protocol.Unmarshal(data)
		if err != nil {
			continue
		}
		if m.Type == protocol.TypeOffer {
			got = m
			break
		}
	}
	if got.Type != protocol.TypeOffer {
		t.Fatalf("agent did not receive the offer, got type=%q", got.Type)
	}
	if got.SDP != "v=0-fake-offer" {
		t.Fatalf("offer payload altered: %q", got.SDP)
	}

	// And the reverse direction.
	answer := protocol.New(protocol.TypeAnswer, "demo")
	answer.SDP = "v=0-fake-answer"
	ap, _ := protocol.Marshal(answer)
	if err := agent.WriteMessage(websocket.TextMessage, ap); err != nil {
		t.Fatalf("agent send: %v", err)
	}

	var back protocol.Message
	for time.Now().Before(deadline) {
		_ = browser.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := browser.ReadMessage()
		if err != nil {
			break
		}
		m, err := protocol.Unmarshal(data)
		if err != nil {
			continue
		}
		if m.Type == protocol.TypeAnswer {
			back = m
			break
		}
	}
	if back.SDP != "v=0-fake-answer" {
		t.Fatalf("browser did not receive answer, got %q", back.SDP)
	}
}

// TestUnpairedRoomReportsWaiting ensures a lone peer is told to wait instead of
// silently dropping messages.
func TestUnpairedRoomReportsWaiting(t *testing.T) {
	logger := log.New(os.Stderr, "[relay-test] ", log.LstdFlags)
	srv := httptest.NewServer(signaling.NewServer(logger).Handler())
	defer srv.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?room=solo&role=browser", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	_, _, err = conn.ReadMessage() // initial status
	if err != nil {
		t.Fatalf("read status: %v", err)
	}

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"v":1,"type":"offer","session":"s","sdp":"x"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read waiting: %v", err)
	}
	if !strings.Contains(string(data), "waiting") {
		t.Fatalf("expected waiting frame, got %s", data)
	}
}

var _ = context.Background
