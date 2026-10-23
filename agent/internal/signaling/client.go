// Package signaling is the agent's WebSocket client for the public relay.
//
// The relay is a dumb forwarder: it pairs the agent and the browser page in a
// room and relays opaque JSON. It never sees or proxies user traffic.
package signaling

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/protocol"
	"github.com/gorilla/websocket"
)

// Client is a signaling connection to the relay.
type Client struct {
	conn *websocket.Conn
	log  *log.Logger
	// done stops the keepalive goroutine on Close.
	done chan struct{}
	once sync.Once
}

// Dial connects to the relay for the given room, presenting the agent role.
func Dial(ctx context.Context, baseURL, room, secret string, logger *log.Logger) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse signaling url: %w", err)
	}
	q := u.Query()
	q.Set("room", room)
	q.Set("role", "agent")
	if secret != "" {
		q.Set("secret", secret)
	}
	u.RawQuery = q.Encode()

	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("dial signaling: %w", err)
	}

	// Notice a silently dead connection, and keep an idle one alive.
	//
	// Both directions matter. The relay pings us, so a PongHandler alone would
	// look sufficient — but a PongHandler only fires when a *pong* arrives, and
	// the relay sends *pings*. Left at that, our own read deadline was never
	// refreshed and every slot died at the 75s mark simultaneously, which is
	// exactly what the logs showed.
	//
	// So: handle the relay's Ping (refreshing our deadline), and ping the relay
	// ourselves so it can refresh its own.
	const pongWait = 75 * time.Second
	const pingEvery = 20 * time.Second
	done := make(chan struct{})
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		// Answer with a pong carrying the same payload, as the spec requires.
		_ = conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
		return nil
	})

	c := &Client{conn: conn, log: logger, done: done}

	// Keep our own connection warm in the outbound direction too. The ticker
	// stops when the connection dies: a write error, or Close() shutting done.
	go func() {
		ticker := time.NewTicker(pingEvery)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	hello := protocol.New(protocol.TypeHello, room)
	hello.Role = "agent"
	if err := c.Send(hello); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return c, nil
}

// Send writes a message.
func (c *Client) Send(m protocol.Message) error {
	payload, err := protocol.Marshal(m)
	if err != nil {
		return err
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

// Receive blocks for the next message.
func (c *Client) Receive() (protocol.Message, error) {
	_, data, err := c.conn.ReadMessage()
	if err != nil {
		return protocol.Message{}, err
	}
	m, err := protocol.Unmarshal(data)
	if err != nil {
		return protocol.Message{}, fmt.Errorf("decode message: %w", err)
	}
	return m, nil
}

// Close closes the connection.
func (c *Client) Close() error {
	c.once.Do(func() {
		if c.done != nil {
			close(c.done)
		}
	})
	return c.conn.Close()
}

// MarshalMessage is a helper for tests.
func MarshalMessage(m protocol.Message) []byte {
	b, _ := json.Marshal(m)
	return b
}
