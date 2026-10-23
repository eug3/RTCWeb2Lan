package signaling_test

import (
	"context"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/signaling"
	"github.com/gorilla/websocket"
)

// dial opens a peer and drains the relay's initial status frame.
func dial(t *testing.T, base, room, role string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(base, "http")+"/ws?room="+room+"&role="+role, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", role, err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("deadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("read %s status: %v", role, err)
	}
	return conn
}

func send(t *testing.T, conn *websocket.Conn, payload string) {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// expect reads one message and requires it to equal want.
func expect(t *testing.T, conn *websocket.Conn, want, what string) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("deadline: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("%s: read: %v", what, err)
	}
	if string(data) != want {
		t.Fatalf("%s: got %q, want %q", what, data, want)
	}
}

// Two browsers must each get their own agent connection. Before the pool, the
// second browser replaced the first, which is what produced the endless
// connecting/closed cycle in the field.
func TestRoomServesTwoBrowsersIndependently(t *testing.T) {
	logger := log.New(os.Stderr, "[relay-test] ", log.LstdFlags)
	srv := httptest.NewServer(signaling.NewServer(logger).Handler())
	defer srv.Close()

	// Two agents join first and sit idle.
	agentA := dial(t, srv.URL, "multi", "agent")
	defer func() { _ = agentA.Close() }()
	agentB := dial(t, srv.URL, "multi", "agent")
	defer func() { _ = agentB.Close() }()

	// Two browsers arrive; each must be bound to a distinct agent.
	browserA := dial(t, srv.URL, "multi", "browser")
	defer func() { _ = browserA.Close() }()
	browserB := dial(t, srv.URL, "multi", "browser")
	defer func() { _ = browserB.Close() }()

	// A's offer must reach one agent, B's the other, and never the same one.
	//
	// Read strictly in turn: a goroutine racing both connections leaves the
	// loser's ReadMessage pending, which then swallows the next message.
	send(t, browserA, "offer-from-A")
	gotA, gotB := "", ""
	if who, ok := tryRead(agentA, "agentA", "offer-from-A"); ok {
		gotA = who
	} else if who, ok := tryRead(agentB, "agentB", "offer-from-A"); ok {
		gotA = who
	}

	send(t, browserB, "offer-from-B")
	// Whichever agent did not carry A's offer must now carry B's.
	if gotA == "agentA" {
		if who, ok := tryRead(agentB, "agentB", "offer-from-B"); ok {
			gotB = who
		}
	} else if gotA == "agentB" {
		if who, ok := tryRead(agentA, "agentA", "offer-from-B"); ok {
			gotB = who
		}
	}

	if gotA == "" {
		t.Fatalf("browser A was not paired with any agent")
	}
	if gotB == "" {
		t.Fatalf("browser B was not paired (both browsers must get their own agent)")
	}
	if gotA == gotB {
		t.Fatalf("both browsers were served by %s; they must not share one", gotA)
	}

	// Replies must reach the right browser.
	if gotA == "agentA" {
		send(t, agentA, "answer-for-A")
		expect(t, browserA, "answer-for-A", "browser A answer")
		send(t, agentB, "answer-for-B")
		expect(t, browserB, "answer-for-B", "browser B answer")
	} else {
		send(t, agentB, "answer-for-A")
		expect(t, browserA, "answer-for-A", "browser A answer")
		send(t, agentA, "answer-for-B")
		expect(t, browserB, "answer-for-B", "browser B answer")
	}
}

// tryRead reads one message with a short deadline and reports whether it equals
// want. name is the connection's label, returned so callers can tell which
// agent served a browser.
func tryRead(conn *websocket.Conn, label, want string) (name string, ok bool) {
	if err := conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond)); err != nil {
		return "", false
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		return "", false
	}
	if string(data) != want {
		return "", false
	}
	return label, true
}

// A browser that arrives before any agent waits rather than being dropped, and
// is bound as soon as an agent appears.
func TestBrowserWaitsThenBinds(t *testing.T) {
	logger := log.New(os.Stderr, "[relay-test] ", log.LstdFlags)
	srv := httptest.NewServer(signaling.NewServer(logger).Handler())
	defer srv.Close()

	browser := dial(t, srv.URL, "late", "browser")
	defer func() { _ = browser.Close() }()

	// With no agent, the relay answers "waiting" instead of forwarding.
	send(t, browser, "early-offer")
	expect(t, browser, `{"v":1,"type":"waiting"}`, "waiting frame")

	agent := dial(t, srv.URL, "late", "agent")
	defer func() { _ = agent.Close() }()

	// The agent that joins later must be bound to the waiting browser.
	send(t, browser, "late-offer")
	expect(t, agent, "late-offer", "offer forwarded to late agent")
}
// A room must not be forgotten while it still holds agent connections. The old
// code decided emptiness from a count taken before the lock was re-acquired, so
// a peer joining in that window ended up in a room the map had already dropped
// — stranding every idle agent with it. This is what made eight agent slots
// collapse to one in the field.
func TestRoomSurvivesWhileAgentsRemain(t *testing.T) {
	logger := log.New(os.Stderr, "[relay-test] ", log.LstdFlags)
	srv := httptest.NewServer(signaling.NewServer(logger).Handler())
	defer srv.Close()

	// Two agents hold slots; a browser joins and leaves.
	agentA := dial(t, srv.URL, "keep", "agent")
	defer func() { _ = agentA.Close() }()
	agentB := dial(t, srv.URL, "keep", "agent")
	defer func() { _ = agentB.Close() }()

	browser := dial(t, srv.URL, "keep", "browser")
	_ = browser.Close()

	// Give the relay a moment to process the browser's departure.
	time.Sleep(300 * time.Millisecond)

	// Both agents must still be usable: a new browser is served without any
	// agent re-dialing.
	browser2 := dial(t, srv.URL, "keep", "browser")
	defer func() { _ = browser2.Close() }()

	send(t, browser2, "after-leave")
	if who, ok := tryRead(agentA, "agentA", "after-leave"); ok {
		_ = who
		return
	}
	if who, ok := tryRead(agentB, "agentB", "after-leave"); ok {
		_ = who
		return
	}
	t.Fatal("neither surviving agent served the new browser; the room was dropped")
}
// A connection must survive past the read deadline as long as the relay keeps
// pinging. The bug this guards against: the client installed only a PongHandler,
// but the relay sends Pings, so the client's own deadline was never refreshed
// and every slot died at the 75s mark at the same instant.
func TestAgentConnectionSurvivesRelayPings(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	logger := log.New(os.Stderr, "[relay-test] ", log.LstdFlags)
	srv := httptest.NewServer(signaling.NewServer(logger).Handler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()

	client, err := signaling.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", "keepalive", "", logger)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	// Read in the background; any error means the deadline fired.
	errCh := make(chan error, 1)
	go func() {
		for {
			if _, err := client.Receive(); err != nil {
				errCh <- err
				return
			}
		}
	}()

	// Past the old 75s deadline. The relay pings every 20s, so a healthy
	// connection should still be alive here.
	select {
	case err := <-errCh:
		t.Fatalf("connection died before the deadline window elapsed: %v", err)
	case <-time.After(80 * time.Second):
	}
}
