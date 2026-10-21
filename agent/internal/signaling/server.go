// Package signaling also provides the relay server.
//
// The relay exists purely for discovery: it pairs one browser and one agent per
// room and forwards opaque JSON between them. It performs no inspection and
// carries no user traffic.
package signaling

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// Peer is one side of a room.
type Peer struct {
	conn *websocket.Conn
	role string
	mu   sync.Mutex
}

// Write sends a message to this peer.
func (p *Peer) Write(b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conn.WriteMessage(websocket.TextMessage, b)
}

// Room holds the two peers.
type Room struct {
	mu      sync.Mutex
	browser *Peer
	agent   *Peer
}

func (r *Room) set(role string, p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if role == "agent" {
		r.agent = p
	} else {
		r.browser = p
	}
}

func (r *Room) other(role string) *Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	if role == "agent" {
		return r.browser
	}
	return r.agent
}

func (r *Room) peer(role string) *Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	if role == "agent" {
		return r.agent
	}
	return r.browser
}

// Server is the relay.
type Server struct {
	upgrader websocket.Upgrader
	log      *log.Logger

	mu    sync.Mutex
	rooms map[string]*Room
}

// NewServer creates a relay server.
func NewServer(logger *log.Logger) *Server {
	return &Server{
		log: logger,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  16 * 1024,
			WriteBufferSize: 16 * 1024,
			// The page is served from the same public host; keep origin checks
			// permissive so a page on any static host can connect.
			CheckOrigin: func(*http.Request) bool { return true },
		},
		rooms: make(map[string]*Room),
	}
}

// Handler returns the HTTP handler for the websocket endpoint.
func (s *Server) Handler() http.Handler {
	return s.HandlerWithStatic("")
}

// HandlerWithStatic serves the signaling websocket at /ws and, when staticDir
// is non-empty, the web bundle from that directory. Serving both from one
// process keeps the deployment to a single distroless container (no shell, no
// sidecar httpd).
func (s *Server) HandlerWithStatic(staticDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		// Non-ASCII prose is fine here; WCSET-style escapes keep it plain ASCII.
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	if staticDir != "" {
		files := http.FileServer(http.Dir(staticDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			// The service worker must control the whole origin.
			if r.URL.Path == "/sw.js" || r.URL.Path == "/src/sw.ts" {
				w.Header().Set("Service-Worker-Allowed", "/")
			}
			// Never cache the SW or index: a stale SW breaks interception.
			if r.URL.Path == "/sw.js" || r.URL.Path == "/" || r.URL.Path == "/index.html" {
				w.Header().Set("Cache-Control", "no-store")
			}
			files.ServeHTTP(w, r)
		})
		s.log.Printf("serving static files from %s", staticDir)
	}
	return mux
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	role := r.URL.Query().Get("role")
	if roomID == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}
	if role != "agent" && role != "browser" {
		role = "browser"
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	peer := &Peer{conn: conn, role: role}

	room := s.getRoom(roomID)
	room.set(role, peer)
	s.log.Printf("room %s: %s joined", roomID, role)

	defer func() {
		s.log.Printf("room %s: %s left", roomID, role)
		s.dropIfSame(roomID, room, role, peer)
		_ = conn.Close()
	}()

	// Tell the newcomer whether the counterpart is present so the page can
	// decide when it is safe to offer.
	s.sendStatus(room, role)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		other := room.other(role)
		if other == nil {
			// Nobody to relay to yet; tell the sender to wait.
			_ = peer.Write([]byte(`{"v":1,"type":"waiting"}`))
			continue
		}
		if err := other.Write(data); err != nil {
			s.log.Printf("room %s: relay to %s failed: %v", roomID, other.role, err)
			return
		}
	}
}

func (s *Server) sendStatus(room *Room, role string) {
	state := "waiting"
	if room.peer("agent") != nil && room.peer("browser") != nil {
		state = "paired"
	}
	self := room.peer(role)
	if self == nil {
		return
	}
	_ = self.Write([]byte(`{"v":1,"type":"ready","state":"` + state + `"}`))

	// When both sides are present, nudge both so the browser can start offering.
	if state == "paired" {
		for _, r := range []string{"agent", "browser"} {
			if p := room.peer(r); p != nil {
				_ = p.Write([]byte(`{"v":1,"type":"ready","state":"paired"}`))
			}
		}
	}
}

func (s *Server) getRoom(id string) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rooms[id]; ok {
		return r
	}
	r := &Room{}
	s.rooms[id] = r
	return r
}

func (s *Server) dropIfSame(id string, room *Room, role string, peer *Peer) {
	room.mu.Lock()
	if role == "agent" {
		if room.agent == peer {
			room.agent = nil
		}
	} else if room.browser == peer {
		room.browser = nil
	}
	empty := room.agent == nil && room.browser == nil
	room.mu.Unlock()

	if empty {
		s.mu.Lock()
		delete(s.rooms, id)
		s.mu.Unlock()
	}
}
