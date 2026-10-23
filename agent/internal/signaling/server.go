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

// Room pairs browsers with agent connections.
//
// A room used to hold exactly one browser and one agent, so a second visitor
// (another tab, or a tablet alongside a laptop) replaced the first. The evicted
// side saw its connection close, reconnected, and evicted the other in turn —
// an endless connecting/closed cycle that surfaces as "peer connection timed
// out" on a slow path.
//
// A room now keeps a pool of agent connections and binds each browser to its
// own for the life of its session. One WebRTC peer connection per browser is
// unavoidable (a peer connection is point-to-point), so the pool lives on the
// agent side and the browser keeps its unchanged single-connection protocol.
type Room struct {
	mu sync.Mutex
	// idle agents: connected, not yet bound to a browser.
	idle []*Peer
	// bound: browser -> the agent connection serving it.
	bound map[*Peer]*Peer
	// waiting: browsers that arrived before any agent was free.
	waiting []*Peer
}

func newRoom() *Room {
	return &Room{bound: make(map[*Peer]*Peer)}
}

// addAgent registers an agent connection, binding it immediately to a browser
// that is already waiting, if any.
func (r *Room) addAgent(p *Peer) (browser *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.waiting) > 0 {
		browser = r.waiting[0]
		r.waiting = r.waiting[1:]
		r.bound[browser] = p
		return browser
	}
	r.idle = append(r.idle, p)
	return nil
}

// addBrowser registers a browser, returning the agent connection bound to it
// (nil when none is free yet).
func (r *Room) addBrowser(p *Peer) (agent *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.idle) > 0 {
		agent = r.idle[0]
		r.idle = r.idle[1:]
		r.bound[p] = agent
		return agent
	}
	r.waiting = append(r.waiting, p)
	return nil
}

// counterpart returns the peer the given one talks to.
func (r *Room) counterpart(p *Peer) *Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.role == "agent" {
		for browser, agent := range r.bound {
			if agent == p {
				return browser
			}
		}
		return nil
	}
	return r.bound[p]
}

// remove drops a peer and its binding, returning how many agent connections the
// room still has (which tells the agent whether it must dial again).
func (r *Room) remove(p *Peer) (agentsLeft int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if p.role == "agent" {
		for i, idle := range r.idle {
			if idle == p {
				r.idle = append(r.idle[:i], r.idle[i+1:]...)
				return len(r.idle) + len(r.bound)
			}
		}
		for browser, agent := range r.bound {
			if agent == p {
				delete(r.bound, browser)
				r.waiting = append(r.waiting, browser)
				break
			}
		}
	} else {
		delete(r.bound, p)
		for i, w := range r.waiting {
			if w == p {
				r.waiting = append(r.waiting[:i], r.waiting[i+1:]...)
				break
			}
		}
	}
	return len(r.idle) + len(r.bound)
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

	var paired bool
	if role == "agent" {
		paired = room.addAgent(peer) != nil
	} else {
		paired = room.addBrowser(peer) != nil
	}
	s.log.Printf("room %s: %s joined (paired=%v)", roomID, role, paired)

	defer func() {
		left := room.remove(peer)
		s.log.Printf("room %s: %s left (agents left=%d)", roomID, role, left)
		s.dropIfEmpty(roomID, room, left)
		_ = conn.Close()
	}()

	// Ready frames are informational — the browser ignores them and offers on
	// its own timer — but they keep the protocol honest for other clients.
	if paired {
		_ = peer.Write([]byte(`{"v":1,"type":"ready","state":"paired"}`))
	} else {
		_ = peer.Write([]byte(`{"v":1,"type":"ready","state":"waiting"}`))
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		other := room.counterpart(peer)
		if other == nil {
			// Nobody bound yet; tell the sender to wait.
			_ = peer.Write([]byte(`{"v":1,"type":"waiting"}`))
			continue
		}
		if err := other.Write(data); err != nil {
			s.log.Printf("room %s: relay to %s failed: %v", roomID, other.role, err)
			return
		}
	}
}

func (s *Server) getRoom(id string) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rooms[id]; ok {
		return r
	}
	r := newRoom()
	s.rooms[id] = r
	return r
}

// dropIfEmpty forgets a room once it has no agent connection left. A room with
// waiting browsers but no agent is kept, so a browser that arrived first is not
// thrown away while the agent is still dialing.
func (s *Server) dropIfEmpty(id string, room *Room, agentsLeft int) {
	if agentsLeft > 0 {
		return
	}
	room.mu.Lock()
	hasWaiters := len(room.waiting) > 0
	room.mu.Unlock()
	if hasWaiters {
		return
	}
	s.mu.Lock()
	delete(s.rooms, id)
	s.mu.Unlock()
}
