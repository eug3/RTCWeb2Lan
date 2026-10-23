// Command tunnelagent exposes intranet HTTP services to a browser over WebRTC.
//
// It dials the public signaling service (discovery only), waits for a browser
// offer, answers it, and then proxies each request received on the "http"
// DataChannel to whichever intranet service the route table selects. It never
// listens on a port: all traffic is outbound.
//
// One agent serves many sites:
//
//	tunnelagent -signal wss://edge.example.com/__lan/ws -room default -routes routes.yaml
//
// A single-target shortcut is kept for quick tests:
//
//	tunnelagent -room demo -target http://192.168.1.10:8080
package main

import (
	"context"
	"net"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"strings"
	"syscall"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/protocol"
	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
	"github.com/beijihu/easytier-web2lan/agent/internal/signaling"
	"github.com/beijihu/easytier-web2lan/agent/internal/tunnel"
	"github.com/pion/webrtc/v4"
)

func main() {
	var (
		signalURL  = flag.String("signal", "ws://127.0.0.1:8787/ws", "signaling relay URL")
		room       = flag.String("room", "default", "room id to join")
		secret     = flag.String("secret", "", "room secret (optional)")
		routesPath = flag.String("routes", "", "route table YAML (multi-site mode)")
		target     = flag.String("target", "", "single target shortcut, e.g. http://10.1.1.230:9011")
		stun       = flag.String("stun", "", "comma-separated STUN URLs")
		turn       = flag.String("turn", "", "comma-separated TURN URLs")
		turnUser   = flag.String("turn-user", "", "TURN username")
		turnPass   = flag.String("turn-pass", "", "TURN credential")
		insecure   = flag.Bool("insecure-upstream", false, "skip TLS verification against upstreams")
		slots      = flag.Int("slots", 8, "signaling slots to hold; one per concurrent browser")
		advCIDR    = flag.String("advertise-cidr", "", "comma-separated CIDRs; only host candidates inside them are advertised, e.g. 10.1.1.0/24,192.168.1.0/24 (srflx/relay always kept)")
	)
	flag.Parse()

	logger := log.New(os.Stderr, "[tunnelagent] ", log.LstdFlags|log.Lmicroseconds)

	routes, err := loadRoutes(*routesPath, *target, *insecure)
	if err != nil {
		logger.Fatalf("%v", err)
	}
	for _, r := range routes.Routes {
		logger.Printf("route %-10s %-24s %-16s -> %s", r.Kind, r.Host, r.Prefix, r.Target)
	}

	var iceServers []webrtc.ICEServer
	if *stun != "" {
		iceServers = append(iceServers, webrtc.ICEServer{URLs: splitList(*stun)})
	}
	if *turn != "" {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs:       splitList(*turn),
			Username:   *turnUser,
			Credential: *turnPass,
		})
	}
	if len(iceServers) == 0 {
		logger.Printf("WARNING: no -stun/-turn provided; only local candidates will be gathered")
	}
	webrtcConfig := webrtc.Configuration{ICEServers: iceServers}

	// A comma-separated list is allowed so an agent can advertise both its
	// overlay address (the stable, preferred path) and its LAN address (an
	// extra chance for a browser that is not on the overlay to punch through
	// NAT). Unrelated interfaces stay filtered out.
	var advertiseNets []*net.IPNet
	if *advCIDR != "" {
		for _, part := range splitList(*advCIDR) {
			_, n, err := net.ParseCIDR(part)
			if err != nil {
				logger.Fatalf("invalid -advertise-cidr entry %q: %v", part, err)
			}
			advertiseNets = append(advertiseNets, n)
		}
		logger.Printf("advertising host candidates only inside %v", advertiseNets)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// One signaling connection serves one browser: a WebRTC peer connection is
	// point-to-point, so N concurrent browsers need N of them. The relay hands
	// each browser a free agent connection, so the agent keeps a pool of slots
	// rather than a single one — otherwise the second visitor waits forever.
	slotCount := *slots
	if slotCount < 1 {
		slotCount = 1
	}
	logger.Printf("holding %d signaling slot(s) in room %q", slotCount, *room)

	var wg sync.WaitGroup
	for i := 0; i < slotCount; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			logger := log.New(os.Stderr, fmt.Sprintf("[tunnelagent#%d] ", n), log.LstdFlags|log.Lmicroseconds)
			for {
				if err := run(ctx, logger, *signalURL, *room, *secret, routes, webrtcConfig, advertiseNets); err != nil {
					if errors.Is(err, context.Canceled) {
						return
					}
					logger.Printf("session ended: %v; retrying in 3s", err)
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(3 * time.Second):
				}
			}
		}(i + 1)
	}
	wg.Wait()
}

// loadRoutes builds the route table from either a YAML file or -target.
func loadRoutes(path, target string, insecure bool) (*relay.RouteTable, error) {
	if path != "" {
		return relay.LoadRoutes(path, insecure)
	}
	if target == "" {
		return nil, errors.New("either -routes or -target is required")
	}
	return relay.SingleRoute(target, insecure)
}

func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func run(
	ctx context.Context,
	logger *log.Logger,
	signalURL, room, secret string,
	routes *relay.RouteTable,
	webrtcConfig webrtc.Configuration,
	advertiseNets []*net.IPNet,
) error {
	client, err := signaling.Dial(ctx, signalURL, room, secret, logger)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	logger.Printf("joined room %q via %s", room, signalURL)

	// Several browsers can share one signaling room now that the relay hands out
	// a dedicated agent connection per browser. Keep one Agent (one WebRTC peer
	// connection) per session id; a peer connection is point-to-point, so this
	// is the minimum possible.
	agents := make(map[string]*tunnel.Agent)
	var agentsMu sync.Mutex

	closeAgent := func(session string) {
		agentsMu.Lock()
		a := agents[session]
		delete(agents, session)
		agentsMu.Unlock()
		if a != nil {
			_ = a.Close()
		}
	}
	closeAll := func() {
		agentsMu.Lock()
		all := agents
		agents = make(map[string]*tunnel.Agent)
		agentsMu.Unlock()
		for _, a := range all {
			_ = a.Close()
		}
	}
	getAgent := func(session string) *tunnel.Agent {
		agentsMu.Lock()
		defer agentsMu.Unlock()
		return agents[session]
	}

	awaitOffer := time.NewTimer(30 * time.Minute)
	defer awaitOffer.Stop()

	msgCh := make(chan protocol.Message, 16)
	errCh := make(chan error, 1)
	go func() {
		for {
			m, err := client.Receive()
			if err != nil {
				errCh <- err
				return
			}
			msgCh <- m
		}
	}()

	for {
		select {
		case <-ctx.Done():
			closeAll()
			return context.Canceled

		case <-awaitOffer.C:
			agentsMu.Lock()
			any := len(agents) > 0
			agentsMu.Unlock()
			if !any {
				return errors.New("no browser offer received within timeout")
			}

		case err := <-errCh:
			closeAll()
			return err

		case m := <-msgCh:
			switch m.Type {
			case protocol.TypeOffer:
				// A repeated offer for the same session replaces that session
				// only; other browsers keep their connections.
				closeAgent(m.Session)
				session := m.Session
				a, err := tunnel.New(webrtcConfig, routes, advertiseNets, func(c webrtc.ICECandidateInit) {
					out := protocol.New(protocol.TypeCandidate, session)
					out.Candidate = c.Candidate
					if c.SDPMid != nil {
						out.SDPMid = *c.SDPMid
					}
					out.SDPMIndex = c.SDPMLineIndex
					if err := client.Send(out); err != nil {
						logger.Printf("send candidate: %v", err)
					}
				}, logger)
				if err != nil {
					logger.Printf("create agent: %v", err)
					out := protocol.New(protocol.TypeError, m.Session)
					out.Message = err.Error()
					_ = client.Send(out)
					continue
				}

				answer, err := a.HandleOffer(m.SDP)
				if err != nil {
					logger.Printf("handle offer: %v", err)
					_ = a.Close()
					out := protocol.New(protocol.TypeError, m.Session)
					out.Message = err.Error()
					_ = client.Send(out)
					continue
				}

				agentsMu.Lock()
				agents[m.Session] = a
				agentsMu.Unlock()

				out := protocol.New(protocol.TypeAnswer, m.Session)
				out.SDP = answer
				if err := client.Send(out); err != nil {
					return err
				}
				logger.Printf("answered offer for session %s", m.Session)

			case protocol.TypeCandidate:
				a := getAgent(m.Session)
				if a == nil {
					continue // candidates may arrive before that session's offer
				}
				init := webrtc.ICECandidateInit{
					Candidate:     m.Candidate,
					SDPMid:        &m.SDPMid,
					SDPMLineIndex: m.SDPMIndex,
				}
				if err := a.AddCandidate(init); err != nil {
					logger.Printf("add candidate: %v", err)
				}

			case protocol.TypeBye:
				logger.Printf("peer said bye for session %s", m.Session)
				closeAgent(m.Session)

			case protocol.TypeHello, protocol.TypeReady:
				logger.Printf("relay says %s", m.Type)

			case protocol.TypeError:
				logger.Printf("relay/browser error: %s", m.Message)
			}
		}
	}
}

var _ = fmt.Sprintf