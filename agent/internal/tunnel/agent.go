// Package tunnel implements the intranet side of the WebRTC tunnel.
//
// The browser opens ONE DataChannel labelled "http" and multiplexes every HTTP
// request over it (see mux.go). This agent demultiplexes them, resolves each
// against a route table, proxies it to the matching intranet service, and
// writes the response back. One agent therefore serves many intranet sites.
package tunnel

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"

	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
	"github.com/pion/webrtc/v4"
)

// ChannelLabel must match the browser side.
const ChannelLabel = "http"

// MTU for chunking messages, matching the browser's 16KiB-1.
const MTU = 16*1024 - 1

// Agent owns one PeerConnection and its tunnels.
type Agent struct {
	log    *log.Logger
	routes *relay.RouteTable
	pc     *webrtc.PeerConnection

	mu      sync.Mutex
	relayed bool
	mux     *muxConn
	jars    map[string]http.CookieJar // one jar per target
}

// New creates an agent. onCandidate is called for locally gathered candidates.
//
// When advertiseCIDR is set, host candidates outside it are not advertised:
// pairs through a routable-but-asymmetric path can pass ICE checks yet never
// carry SCTP data, which shows up as connections that open channels but never
// deliver a response. Restricting advertisement pins peers onto the overlay
// network. Server-reflexive and relay candidates are always advertised so
// external browsers keep a path in.
func New(
	cfg webrtc.Configuration,
	routes *relay.RouteTable,
	advertiseCIDR *net.IPNet,
	onCandidate func(webrtc.ICECandidateInit),
	logger *log.Logger,
) (*Agent, error) {
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("new peer connection: %w", err)
	}

	a := &Agent{log: logger, routes: routes, pc: pc, jars: make(map[string]http.CookieJar)}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		if advertiseCIDR != nil && c.Typ == webrtc.ICECandidateTypeHost {
			ip := net.ParseIP(c.Address)
			if ip == nil || !advertiseCIDR.Contains(ip) {
				logger.Printf("skip host candidate %s (outside advertise CIDR)", c.Address)
				return
			}
		}
		if c.Typ == webrtc.ICECandidateTypeRelay {
			a.mu.Lock()
			a.relayed = true
			a.mu.Unlock()
		}
		onCandidate(c.ToJSON())
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		logger.Printf("connection state: %s", s)
	})

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		logger.Printf("data channel %q id=%d", dc.Label(), dcID(dc))
		if dc.Label() != ChannelLabel {
			_ = dc.Close()
			return
		}
		// Register the message handler SYNCHRONOUSLY, before returning to pion.
		// pion starts the channel's SCTP read loop from inside its own
		// OnDataChannel dispatch (handleOpen -> go readLoop) right after this
		// callback returns. If we deferred OnMessage registration to a
		// goroutine, the first request fragment could reach the read loop
		// before the handler was set, and pion silently drops messages when
		// the handler is nil (datachannel.onMessage: "if handler == nil { return }").
		// That is the field "channel opens but the request never arrives" wedge.
		// The buffered pipe below absorbs anything that arrives while the
		// request goroutine is still starting up.
		a.serveChannel(dc)
	})

	return a, nil
}

func dcID(dc *webrtc.DataChannel) uint16 {
	if id := dc.ID(); id != nil {
		return *id
	}
	return 0
}

// HandleOffer sets the remote description, creates the answer, and returns it.
func (a *Agent) HandleOffer(sdp string) (string, error) {
	if err := a.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  sdp,
	}); err != nil {
		return "", fmt.Errorf("set remote description: %w", err)
	}

	answer, err := a.pc.CreateAnswer(nil)
	if err != nil {
		return "", fmt.Errorf("create answer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(a.pc)
	if err := a.pc.SetLocalDescription(answer); err != nil {
		return "", fmt.Errorf("set local description: %w", err)
	}

	// Waiting for gathering completion yields a self-contained answer.
	<-gatherComplete

	local := a.pc.LocalDescription()
	if local == nil {
		return "", fmt.Errorf("local description missing")
	}
	return local.SDP, nil
}

// AddCandidate feeds a remote ICE candidate.
func (a *Agent) AddCandidate(c webrtc.ICECandidateInit) error {
	return a.pc.AddICECandidate(c)
}

// IsRelayed reports whether any local candidate was of type relay.
func (a *Agent) IsRelayed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.relayed
}

// Close shuts the peer connection down.
func (a *Agent) Close() error { return a.pc.Close() }

// serveChannel starts the multiplexer for a DataChannel.
//
// ONE channel now carries every exchange (see mux.go): opening a channel per
// request meant each request depended on a fresh DCEP handshake that Chrome and
// pion frequently never completed, and stream resets poisoned later streams on
// the same association. The OnMessage handler is registered synchronously,
// before pion's read loop starts, or the first fragment is silently dropped.
func (a *Agent) serveChannel(dc *webrtc.DataChannel) {
	m := newMuxConn(dc, a.log, a.proxy)
	a.mu.Lock()
	a.mux = m
	a.mu.Unlock()
}

// proxy forwards one request to the routed intranet target.
func (a *Agent) proxy(req *http.Request) (*http.Response, error) {
	host := stripPort(req.Host)
	target, upstreamPath, ok := a.routes.Match(host, req.URL.Path)
	if !ok {
		a.log.Printf("no route: host=%s path=%s", host, req.URL.Path)
		return simpleResponse(http.StatusNotFound, "no route for "+host+req.URL.Path), nil
	}

	req.URL.Path = upstreamPath
	a.log.Printf("%s %s%s -> %s", req.Method, req.URL.Path, queryString(req.URL), target.URL)

	// Give the request an absolute URL before handing it to the client.
	//
	// http.ReadRequest leaves req.URL relative (only the path); the host lives
	// in req.Host. http.Client applies the cookie jar by looking up
	// jar.Cookies(req.URL), so with a relative URL the lookup has no host to
	// match and always returns nothing — the agent's jar silently never
	// contributed a cookie, which made every tunnelled request look logged out
	// even after a successful login over the tunnel.
	//
	// The scheme/host here only drive the jar lookup; Transport rewrites them to
	// the real target afterwards.
	req.URL.Scheme = "http"
	req.URL.Host = req.Host

	client := a.httpClient(target)
	resp, err := client.Do(req)
	if err != nil {
		a.log.Printf("proxy request: %v", err)
		return simpleResponse(http.StatusBadGateway, "upstream error: "+err.Error()), nil
	}
	return resp, nil
}

func stripPort(hostport string) string {
	if i := strings.LastIndex(hostport, ":"); i > 0 && !strings.Contains(hostport[i:], "]") {
		return hostport[:i]
	}
	return hostport
}

func queryString(u *url.URL) string {
	if u.RawQuery == "" {
		return ""
	}
	return "?" + u.RawQuery
}

// httpClient builds a client with a per-target cookie jar.
// Cookies cannot be managed from a Service Worker, so they are kept here.
func (a *Agent) httpClient(target *relay.Target) *http.Client {
	a.mu.Lock()
	jar, ok := a.jars[target.URL.String()]
	if !ok {
		jar, _ = cookiejar.New(nil)
		a.jars[target.URL.String()] = jar
	}
	a.mu.Unlock()

	return &http.Client{
		Jar:       jar,
		Transport: target.Transport(),
		// Never follow redirects here: the browser decides, which keeps address
		// semantics identical to a direct visit.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
