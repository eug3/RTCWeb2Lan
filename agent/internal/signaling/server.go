// Package signaling also provides the relay server.
//
// The relay exists purely for discovery: it pairs one browser and one agent per
// room and forwards opaque JSON between them. It performs no inspection and
// carries no user traffic.
package signaling

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Peer is one side of a room.
type Peer struct {
	conn *websocket.Conn
	role string
	mu   sync.Mutex
	// active is set once a browser sends its first frame. A page opens its
	// signaling socket before it has anything to say (and the holder re-opens
	// one every few seconds while it decides), so "connected" is not the same
	// as "wants a tunnel". Binding on connect burned the whole agent pool on
	// sockets that never sent a byte.
	active atomic.Bool
}

// Write sends a message to this peer.
func (p *Peer) Write(b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	// A write without a deadline blocks forever on a half-dead TCP connection,
	// and every caller holds the peer lock while it does. Nothing can then be
	// forwarded to this peer, and the room cannot free the slot either.
	_ = p.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return p.conn.WriteMessage(websocket.TextMessage, b)
}

// probe flushes the connection so dead peers surface as an error.
//
// A control frame proves nothing on its own: gorilla reports a successful write
// once the bytes are buffered, even when the socket has been reset. This is why
// peer death used to go unnoticed and room slots piled up (agents left=33). The
// flush is what turns "the far end is gone" into an error we can act on.
func (p *Peer) probe() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = p.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
		return err
	}
	return p.conn.UnderlyingConn().SetWriteDeadline(time.Now().Add(writeTimeout))
}

const (
	// writeTimeout bounds a single write so a dead peer cannot hold the lock
	// (and therefore the room) indefinitely.
	writeTimeout = 10 * time.Second
	// livenessCheckEvery is how often an idle connection is proven alive.
	livenessCheckEvery = 20 * time.Second
)

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
	for i, w := range r.waiting {
		if !w.active.Load() {
			continue
		}
		r.waiting = append(r.waiting[:i], r.waiting[i+1:]...)
		r.bound[w] = p
		return w
	}
	r.idle = append(r.idle, p)
	return nil
}

// addBrowser queues a browser. It is NOT bound here: see ensureBound.
func (r *Room) addBrowser(p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.waiting = append(r.waiting, p)
}

// ensureBound binds a browser to an idle agent the first time it speaks, and
// returns the agent it talks to (nil while it must wait).
//
// Binding at connect time was the pool leak: every socket a page opened — and
// the holder opens one every few seconds while it decides — took an agent slot
// for the life of that socket, whether or not it ever sent an offer. The pool
// drained, and the next real visitor was told "waiting" until it timed out.
func (r *Room) ensureBound(p *Peer) *Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	if agent, ok := r.bound[p]; ok {
		return agent
	}
	if len(r.idle) == 0 {
		return nil
	}
	agent := r.idle[0]
	r.idle = r.idle[1:]
	r.bound[p] = agent
	for i, w := range r.waiting {
		if w == p {
			r.waiting = append(r.waiting[:i], r.waiting[i+1:]...)
			break
		}
	}
	return agent
}

// detach releases a browser's agent once the tunnel no longer needs signaling.
//
// The binding exists so an offer can reach an agent and candidates can flow the
// other way. Once the page has a verified DataChannel none of that is needed,
// yet the socket used to stay open (and kept its agent) for the life of the
// tab: a few tabs and reconnects filled the pool for everyone else. Detaching
// is not "bye" — the agent keeps its live peer; only the relay's bookkeeping
// goes away.
func (r *Room) detach(p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, w := range r.waiting {
		if w == p {
			r.waiting = append(r.waiting[:i], r.waiting[i+1:]...)
			break
		}
	}
	agent, ok := r.bound[p]
	if !ok {
		return
	}
	delete(r.bound, p)
	r.idle = append(r.idle, agent)
	_ = agent.Write([]byte(`{"v":1,"type":"ready","state":"waiting"}`))
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

// remove drops a peer and its binding.
//
// A dying agent connection must not inherit a waiting browser: the agent is
// about to close its socket and would leave that browser waiting again, so the
// browser goes back to the head of the queue and the agent slot is handed back
// to its owner via freeAgent. agentsLeft reports how many agent connections the
// room still holds (informational, for the log line).
func (r *Room) remove(p *Peer) (agentsLeft int, freeAgent bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if p.role == "agent" {
		for i, idle := range r.idle {
			if idle == p {
				r.idle = append(r.idle[:i], r.idle[i+1:]...)
				return len(r.idle) + len(r.bound), true
			}
		}
		for browser, agent := range r.bound {
			if agent == p {
				delete(r.bound, browser)
				// Back to the front of the queue: it was waiting longest.
				r.waiting = append([]*Peer{browser}, r.waiting...)
				break
			}
		}
		return len(r.idle) + len(r.bound), true
	}

	// A browser left. The waiting list is scanned first: a browser that was
	// queued before it bonded is no longer a live peer, and handing it to an
	// idle agent strands a real visitor behind a dead one. (That was the 2026-11
	// outage: every browser for 45 minutes was rejected with "write tcp ...
	// i/o timeout", then "answer timed out" in the page.)
	for i, w := range r.waiting {
		if w == p {
			r.waiting = append(r.waiting[:i], r.waiting[i+1:]...)
			return len(r.idle) + len(r.bound), false
		}
	}
	for browser, agent := range r.bound {
		if browser == p {
			delete(r.bound, browser)
			// Notify the paired agent that its browser departed so it can tear
			// down the session. Its slot then returns to waiting (idle) or is
			// handed to the next queued browser. Both writes are best-effort:
			// a dead agent must not break the relay for everyone else.
			_ = agent.Write([]byte(`{"v":1,"type":"bye"}`))
			if len(r.waiting) > 0 {
				nextBrowser := r.waiting[0]
				r.waiting = r.waiting[1:]
				r.bound[nextBrowser] = agent
				_ = agent.Write([]byte(`{"v":1,"type":"ready","state":"paired"}`))
				_ = nextBrowser.Write([]byte(`{"v":1,"type":"ready","state":"paired"}`))
			} else {
				r.idle = append(r.idle, agent)
				_ = agent.Write([]byte(`{"v":1,"type":"ready","state":"waiting"}`))
			}
			break
		}
	}
	return len(r.idle) + len(r.bound), false
}

// Server is the relay.
type Server struct {
	upgrader websocket.Upgrader
	log      *log.Logger

	mu    sync.Mutex
	rooms map[string]*Room
	// slots carries rooms that lost an agent connection, so the agent can dial
	// a replacement slot. See releaseSlot.
	slots chan string
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
		slots: make(chan string, 64),
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

	// out serialises this connection's writes. The read loop must never write
	// directly: a browser dying mid-frame used to block it for the full TCP
	// timeout, and nothing else could ever be delivered to that browser.
	out := make(chan []byte, outQueue)
	outDone := make(chan struct{})
	go writeLoop(peer, out, outDone)

	// Keep the connection warm and notice when the far end dies. A pong is
	// answered automatically by the gorilla read loop; the deadline below is
	// what turns "no pong" into an actual read error.
	done := make(chan struct{})
	defer close(done)
	defer close(outDone)
	go keepalive(conn, done, peer.probe)
	const pongWait = 75 * time.Second
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	room := s.getRoom(roomID)

	var paired bool
	if role == "agent" {
		paired = room.addAgent(peer) != nil
	} else {
		// Queue only; the agent is chosen when this browser speaks.
		room.addBrowser(peer)
	}
	s.log.Printf("room %s: %s joined (paired=%v)", roomID, role, paired)

	// frames hands a payload to the writer without blocking the room.
	frames := func(b []byte) {
		select {
		case out <- b:
		default:
			// A peer this far behind is gone in every sense that matters.
			s.log.Printf("room %s: %s send buffer full; dropping peer", roomID, role)
			_ = conn.Close()
		}
	}

	defer func() {
		agentsLeft, freeAgent := room.remove(peer)
		s.log.Printf("room %s: %s left (agents left=%d)", roomID, role, agentsLeft)
		s.dropIfEmpty(roomID, room)
		_ = conn.Close()
		if freeAgent {
			s.releaseSlot(roomID)
		}
	}()

	// Ready frames are informational — the browser ignores them and offers on
	// its own timer — but they keep the protocol honest for other clients.
	if paired {
		frames([]byte(`{"v":1,"type":"ready","state":"paired"}`))
	} else {
		frames([]byte(`{"v":1,"type":"ready","state":"waiting"}`))
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		// A page that has finished signaling says so and closes the socket; the
		// agent slot must go back to the pool, not wait for the tab to die.
		if peer.role == "browser" {
			var head struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(data, &head) == nil && head.Type == "detach" {
				room.detach(peer)
				continue
			}
		}

		var other *Peer
		if peer.role == "browser" {
			peer.active.Store(true)
			other = room.ensureBound(peer)
		} else {
			other = room.counterpart(peer)
		}
		if other == nil {
			// Nobody bound yet; tell the sender to wait.
			frames([]byte(`{"v":1,"type":"waiting"}`))
			continue
		}
		if err := other.Write(data); err != nil {
			// The far end is gone. Drop OUR connection too: our defer then frees
			// the slot, and the agent (which asked for it) dials a fresh one.
			// Returning here without closing left the room holding a corpse
			// whose socket stayed open until the process restarted.
			s.log.Printf("room %s: relay to %s failed: %v", roomID, other.role, err)
			_ = conn.Close()
			return
		}
	}
}

// outQueue bounds how far a peer may lag before it is considered gone.
const outQueue = 64

// writeLoop is the only writer for a peer after its status frame.
func writeLoop(p *Peer, out <-chan []byte, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case b := <-out:
			if err := p.Write(b); err != nil {
				// Dropping the socket wakes the reader, whose defer cleans up.
				_ = p.conn.Close()
				return
			}
		}
	}
}

// releaseSlot asks the room's agent to dial one more connection.
//
// The agent holds a fixed number of signaling slots and only re-dials when it
// hears this frame; every other path leaves it in a state where it must never
// dial (a live connection would be dropped by the relay as a duplicate). So a
// slot that dies here is reported exactly once.
func (s *Server) releaseSlot(roomID string) {
	select {
	case s.slots <- roomID:
	default:
		// The buffer only exists so a departing peer never blocks; a full one
		// means an agent is not reading, and it re-dials on its own timer.
		_ = roomID
	}
}

// Slots reports which rooms have asked for a replacement agent connection.
func (s *Server) Slots() <-chan string { return s.slots }

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

// dropIfEmpty forgets a room once it holds no peers at all.
//
// The check is done against the room currently stored under id, not against the
// snapshot the caller computed: between remove() returning and this call a new
// peer may have joined, and deleting the room then would strand that peer in an
// orphaned struct (and strand every idle agent connection with it).
func (s *Server) dropIfEmpty(id string, room *Room) {
	room.mu.Lock()
	empty := len(room.idle) == 0 && len(room.bound) == 0 && len(room.waiting) == 0
	room.mu.Unlock()
	if !empty {
		return
	}
	s.mu.Lock()
	// Only drop the exact room we inspected; if it was replaced, leave it.
	if cur, ok := s.rooms[id]; ok && cur == room {
		delete(s.rooms, id)
	}
	s.mu.Unlock()
}

// keepalive proves a websocket is still usable, so idle NAT mappings do not
// expire silently and a dead peer is not handed out as a live one.
//
// Without this, a connection through NAT can be dropped by the network with
// neither side noticing: the peer never reads EOF, so the relay keeps handing
// it out as a live agent and browsers pair with a corpse. The symptom is a room
// that reports agents present while every browser waits forever.
func keepalive(conn *websocket.Conn, done <-chan struct{}, probe func() error) {
	ticker := time.NewTicker(livenessCheckEvery)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := probe(); err != nil {
				// Close rather than return: the reader then sees the error and
				// runs the cleanup that frees the room slot.
				_ = conn.Close()
				return
			}
		}
	}
}
