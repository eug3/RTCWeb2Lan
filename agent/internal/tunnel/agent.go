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

	// Admission filters, kept so HandleOffer can apply them to the candidate
	// lines embedded in the answer SDP as well, not only to trickled ones.
	advertiseCIDRs []*net.IPNet
	advertiseTypes []webrtc.ICECandidateType

	mu      sync.Mutex
	relayed bool
	mux     *muxConn
	jars    map[string]http.CookieJar // one jar per target
}

// New creates an agent. onCandidate is called for locally gathered candidates.
//
// Admission is controlled by two filters, applied to BOTH channels a candidate
// can reach the browser through: the trickled candidates (onCandidate) and the
// candidate lines embedded in the answer SDP. Filtering only the trickle path
// would be ineffective: after gathering completes, pion's LocalDescription()
// embeds every candidate the gatherer produced, whatever OnICECandidate did.
//
// When advertiseCIDRs is non-empty, host candidates outside every listed
// network are not advertised:
// pairs through a routable-but-asymmetric path can pass ICE checks yet never
// carry SCTP data, which shows up as connections that open channels but never
// deliver a response. Restricting advertisement pins peers onto the networks
// you name.
//
// When advertiseTypes is non-empty, only those candidate types (host, srflx,
// relay) are advertised at all — e.g. srflx-only, to test that browsers can
// still connect through pure NAT punching with no reachable host address.
//
// Several networks are allowed on purpose: advertising both the overlay address
// (preferred, stable) and the LAN address (an extra NAT-punching chance for a
// browser outside the overlay) covers both kinds of client, while unrelated
// interfaces (docker bridges, VPN adapters) stay hidden.
func New(
	cfg webrtc.Configuration,
	routes *relay.RouteTable,
	advertiseCIDRs []*net.IPNet,
	advertiseTypes []webrtc.ICECandidateType,
	onCandidate func(webrtc.ICECandidateInit),
	logger *log.Logger,
) (*Agent, error) {
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("new peer connection: %w", err)
	}

	a := &Agent{
		log:            logger,
		routes:         routes,
		pc:             pc,
		advertiseCIDRs: advertiseCIDRs,
		advertiseTypes: advertiseTypes,
		jars:           make(map[string]http.CookieJar),
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		if !candidateAdmitted(c.Typ, c.Address, advertiseCIDRs, advertiseTypes) {
			logger.Printf("skip %s candidate %s (advertise filter)", c.Typ, c.Address)
			return
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

// hostCandidateAllowed reports whether a host candidate address should be
// advertised, given the configured networks.
//
// An empty list means "no restriction": advertise whatever the host gathers.
// Otherwise the address must fall inside one of the listed networks, which is
// how unrelated interfaces (docker bridges, VPN adapters) are kept out.
func hostCandidateAllowed(addr string, nets []*net.IPNet) bool {
	if len(nets) == 0 {
		return true
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// candidateAdmitted reports whether a gathered candidate of the given type and
// address may be advertised to the browser.
//
// advertiseTypes non-empty restricts advertisement to those types (used for
// srflx-only connection tests); host candidates additionally pass the CIDR
// filter above. Both lists empty means everything gathered is advertised.
func candidateAdmitted(typ webrtc.ICECandidateType, addr string, cidrs []*net.IPNet, types []webrtc.ICECandidateType) bool {
	if len(types) > 0 {
		allowed := false
		for _, t := range types {
			if t == typ {
				allowed = true
				break
			}
		}
		if !allowed {
			return false
		}
	}
	if typ == webrtc.ICECandidateTypeHost && !hostCandidateAllowed(addr, cidrs) {
		return false
	}
	return true
}

// stripUnadvertisedCandidates removes the a=candidate lines the admission
// filters reject from an SDP, returning the cleaned SDP and how many lines
// were dropped.
//
// pion embeds every gathered candidate into LocalDescription() once gathering
// completes, so filtering the OnICECandidate trickle path alone leaves the
// rejected candidates in the answer, where setRemoteDescription makes the
// browser use them anyway.
func stripUnadvertisedCandidates(sdp string, cidrs []*net.IPNet, types []webrtc.ICECandidateType) (string, int) {
	if len(cidrs) == 0 && len(types) == 0 {
		return sdp, 0
	}
	nl := "\r\n"
	if !strings.Contains(sdp, nl) {
		nl = "\n"
	}
	lines := strings.Split(sdp, nl)
	stripped := 0
	out := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(line, "a=candidate:") && !candidateLineAdmitted(line, cidrs, types) {
			stripped++
			continue
		}
		out = append(out, line)
	}
	if stripped == 0 {
		return sdp, 0
	}
	return strings.Join(out, nl), stripped
}

// candidateLineAdmitted applies candidateAdmitted to one a=candidate line.
// Malformed lines are kept rather than guessed at.
func candidateLineAdmitted(line string, cidrs []*net.IPNet, types []webrtc.ICECandidateType) bool {
	fields := strings.Fields(strings.TrimPrefix(line, "a=candidate:"))
	if len(fields) < 6 {
		return true
	}
	addr := fields[4]
	for i, f := range fields {
		if f == "typ" && i+1 < len(fields) {
			typ, err := webrtc.NewICECandidateType(fields[i+1])
			if err != nil {
				return true
			}
			return candidateAdmitted(typ, addr, cidrs, types)
		}
	}
	return true
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
	sdp, stripped := stripUnadvertisedCandidates(local.SDP, a.advertiseCIDRs, a.advertiseTypes)
	if stripped > 0 {
		a.log.Printf("stripped %d unadvertised candidate(s) from answer SDP", stripped)
	}
	return sdp, nil
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
