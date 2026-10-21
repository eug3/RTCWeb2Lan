// Package tunnel implements the intranet side of the WebRTC tunnel.
//
// For each HTTP request the browser opens a fresh DataChannel labelled "http".
// This agent reads the serialized HTTP/1.1 request, resolves it against a route
// table, proxies it to the matching intranet service, and writes the response
// back. One agent therefore serves many intranet sites.
package tunnel

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// ChannelLabel must match the browser side.
const ChannelLabel = "http"

// MTU for chunking messages, matching the browser's 16KiB-1.
const MTU = 16*1024 - 1

// Agent owns one PeerConnection and its tunnels.
type Agent struct {
	log    *log.Logger
	routes *RouteTable
	pc     *webrtc.PeerConnection

	mu      sync.Mutex
	relayed bool
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
	routes *RouteTable,
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
		go a.serveChannel(dc)
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

// serveChannel handles exactly one HTTP request/response over one DataChannel.
func (a *Agent) serveChannel(dc *webrtc.DataChannel) {
	reader, writer := io.Pipe()
	// Do NOT close the DataChannel after responding: resetting an SCTP
	// stream right after a large transfer wedges every stream opened later on
	// the same association (verified: 2nd MB-sized transfer always died).
	// Channels are reclaimed when the peer connection closes; the per-request
	// leak is bounded by the page lifetime (SCTP allows 65535 streams).
	defer func() {
		_ = reader.Close()
	}()

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if len(msg.Data) == 0 {
			_ = writer.Close() // end of request
			return
		}
		if _, err := writer.Write(msg.Data); err != nil {
			a.log.Printf("write to pipe: %v", err)
			_ = dc.Close()
		}
	})

	// A wedged SCTP stream opens the channel but never delivers the request
	// bytes; without a deadline the browser-side retry (fresh channel) could
	// never take over because this read would block forever.
	readTimer := time.AfterFunc(15*time.Second, func() {
		_ = writer.CloseWithError(errors.New("request read timeout"))
		_ = dc.Close()
	})
	req, err := http.ReadRequest(bufio.NewReader(reader))
	readTimer.Stop()
	if err != nil {
		a.log.Printf("read request: %v", err)
		return
	}
	req.RequestURI = ""
	defer func() { _ = req.Body.Close() }()

	host := stripPort(req.Host)
	target, upstreamPath, ok := a.routes.Match(host, req.URL.Path)
	if !ok {
		a.log.Printf("no route: host=%s path=%s", host, req.URL.Path)
		a.writeSimple(dc, http.StatusNotFound, "no route for "+host+req.URL.Path)
		return
	}

	req.URL.Path = upstreamPath
	a.log.Printf("%s %s%s -> %s", req.Method, req.URL.Path, queryString(req.URL), target.URL)

	resp, err := a.httpClient(target).Do(req)
	if err != nil {
		a.log.Printf("proxy request: %v", err)
		a.writeSimple(dc, http.StatusBadGateway, "upstream error: "+err.Error())
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if err := writeResponse(dc, resp); err != nil {
		a.log.Printf("write response: %v", err)
	}
}

func stripPort(hostport string) string {
	if i := strings.LastIndex(hostport, ":"); i > 0 && !strings.Contains(hostport[i:], "]") {
		return hostport[:i]
	}
	return hostport
}

func (a *Agent) writeSimple(dc *webrtc.DataChannel, status int, body string) {
	resp := &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Content-Type": {"text/plain; charset=utf-8"}},
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
	if err := writeResponse(dc, resp); err != nil {
		a.log.Printf("write simple response: %v", err)
	}
}

func queryString(u *url.URL) string {
	if u.RawQuery == "" {
		return ""
	}
	return "?" + u.RawQuery
}

// httpClient builds a client with a per-target cookie jar.
// Cookies cannot be managed from a Service Worker, so they are kept here.
func (a *Agent) httpClient(target *Target) *http.Client {
	a.mu.Lock()
	jar, ok := a.jars[target.URL.String()]
	if !ok {
		jar, _ = cookiejar.New(nil)
		a.jars[target.URL.String()] = jar
	}
	a.mu.Unlock()

	return &http.Client{
		Jar:       jar,
		Transport: target.transport(),
		// Never follow redirects here: the browser decides, which keeps address
		// semantics identical to a direct visit.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// writeResponse fragments the serialized response, then sends the empty
// end-of-message marker.
//
// Sends are backpressured on the SCTP buffer amount: without a cap a burst of
// multi-megabyte responses makes pion buffer unboundedly, and the association
// degrades to a wedge after a couple of transfers.
const maxSendBuffered = 1 * 1024 * 1024

func writeResponse(dc *webrtc.DataChannel, resp *http.Response) error {
	pr, pw := io.Pipe()

	errCh := make(chan error, 1)
	go func() {
		bw := bufio.NewWriterSize(pw, MTU)
		err := resp.Write(bw)
		if err == nil {
			err = bw.Flush()
		}
		_ = pw.CloseWithError(err)
		errCh <- err
	}()

	buf := make([]byte, MTU)
	var sendErr error
	for {
		n, err := pr.Read(buf)
		if n > 0 {
			// Let the SCTP layer drain before queueing the next chunk.
			for dc.BufferedAmount() > maxSendBuffered {
				time.Sleep(5 * time.Millisecond)
			}
			if e := dc.Send(buf[:n]); e != nil {
				sendErr = e
				_ = pr.Close()
				break
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			sendErr = err
			break
		}
	}
	_ = pr.Close()

	if err := <-errCh; err != nil && sendErr == nil {
		return err
	}
	if sendErr != nil {
		return sendErr
	}
	return dc.Send(nil)
}
