// Command web2lan-agent exposes intranet HTTP services to a browser over WebRTC.
//
// The agent dials the public signaling relay (discovery only), waits for a
// browser offer, answers it, and then proxies each request received on the
// "http" DataChannel to whichever intranet service the route table selects.
//
// One agent serves many sites:
//
//	web2lan-agent -signal ws://127.0.0.1:8787/ws -room lan -routes routes.yaml
//
// A single-target shortcut is kept for quick tests:
//
//	web2lan-agent -room demo -target http://10.1.1.230:9011
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
	"strings"
	"syscall"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/protocol"
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
		advCIDR    = flag.String("advertise-cidr", "", "only advertise host candidates inside this CIDR, e.g. 10.1.1.0/24 (srflx/relay always kept)")
	)
	flag.Parse()

	logger := log.New(os.Stderr, "[web2lan-agent] ", log.LstdFlags|log.Lmicroseconds)

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

	var advertiseNet *net.IPNet
	if *advCIDR != "" {
		_, n, err := net.ParseCIDR(*advCIDR)
		if err != nil {
			logger.Fatalf("invalid -advertise-cidr: %v", err)
		}
		advertiseNet = n
		logger.Printf("advertising host candidates only inside %s", *advCIDR)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	for {
		if err := run(ctx, logger, *signalURL, *room, *secret, routes, webrtcConfig, advertiseNet); err != nil {
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
}

// loadRoutes builds the route table from either a YAML file or -target.
func loadRoutes(path, target string, insecure bool) (*tunnel.RouteTable, error) {
	if path != "" {
		return tunnel.LoadRoutes(path, insecure)
	}
	if target == "" {
		return nil, errors.New("either -routes or -target is required")
	}
	return tunnel.SingleRoute(target, insecure)
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
	routes *tunnel.RouteTable,
	webrtcConfig webrtc.Configuration,
	advertiseNet *net.IPNet,
) error {
	client, err := signaling.Dial(ctx, signalURL, room, secret, logger)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	logger.Printf("joined room %q via %s", room, signalURL)

	var agent *tunnel.Agent

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
			if agent != nil {
				_ = agent.Close()
			}
			return context.Canceled

		case <-awaitOffer.C:
			if agent == nil {
				return errors.New("no browser offer received within timeout")
			}

		case err := <-errCh:
			if agent != nil {
				_ = agent.Close()
			}
			return err

		case m := <-msgCh:
			switch m.Type {
			case protocol.TypeOffer:
				if agent != nil {
					_ = agent.Close()
				}
				a, err := tunnel.New(webrtcConfig, routes, advertiseNet, func(c webrtc.ICECandidateInit) {
					out := protocol.New(protocol.TypeCandidate, m.Session)
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

				agent = a
				out := protocol.New(protocol.TypeAnswer, m.Session)
				out.SDP = answer
				if err := client.Send(out); err != nil {
					return err
				}
				logger.Printf("answered offer for session %s", m.Session)

			case protocol.TypeCandidate:
				if agent == nil {
					continue // candidates may arrive before the agent exists
				}
				init := webrtc.ICECandidateInit{
					Candidate:     m.Candidate,
					SDPMid:        &m.SDPMid,
					SDPMLineIndex: m.SDPMIndex,
				}
				if err := agent.AddCandidate(init); err != nil {
					logger.Printf("add candidate: %v", err)
				}

			case protocol.TypeBye:
				logger.Printf("peer said bye for session %s", m.Session)
				if agent != nil {
					_ = agent.Close()
					agent = nil
				}

			case protocol.TypeHello, protocol.TypeReady:
				logger.Printf("relay says %s", m.Type)

			case protocol.TypeError:
				logger.Printf("relay/browser error: %s", m.Message)
			}
		}
	}
}

var _ = fmt.Sprintf
