// Command sdpdump joins a room as a browser, offers, and prints the answer SDP.
//
// Diagnostic only: it answers the question "which addresses does the agent
// actually advertise to the page?" — host candidates, the srflx address STUN
// discovered for it, or nothing at all when STUN is unreachable.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type signal struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	Session   string `json:"session"`
	SDP       string `json:"sdp,omitempty"`
	Candidate string `json:"candidate,omitempty"`
}

func main() {
	signalURL := flag.String("signal", "wss://sense.jshuaxin.net/__lan/ws", "signaling websocket")
	room := flag.String("room", "lan", "room")
	stun := flag.String("stun", "stun:stun.chat.bilibili.com:3478", "comma-separated STUN URLs")
	wait := flag.Duration("wait", 6*time.Second, "how long to collect trickled candidates after the answer")
	verbose := flag.Bool("v", false, "print each trickled candidate as it arrives")
	flag.Parse()

	u, _ := url.Parse(*signalURL)
	q := u.Query()
	q.Set("room", *room)
	q.Set("role", "browser")
	u.RawQuery = q.Encode()

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	var ice []webrtc.ICEServer
	for _, s := range strings.Split(*stun, ",") {
		if s = strings.TrimSpace(s); s != "" {
			ice = append(ice, webrtc.ICEServer{URLs: []string{s}})
		}
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: ice})
	if err != nil {
		log.Fatalf("peer: %v", err)
	}
	defer pc.Close()

	session := "sdpdump-" + time.Now().Format("150405")
	remote := map[string]bool{}
	fromAnswer := map[string]bool{}
	if _, err := pc.CreateDataChannel("http", nil); err != nil {
		log.Fatalf("channel: %v", err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		log.Fatalf("offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		log.Fatalf("setlocal: %v", err)
	}

	send := func(m signal) {
		b, _ := json.Marshal(m)
		if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
			log.Fatalf("send: %v", err)
		}
	}
	send(signal{V: 1, Type: "offer", Session: session, SDP: pc.LocalDescription().SDP})

	var answer string
	deadline := time.Now().Add(*wait)
	for time.Now().Before(deadline) && answer == "" {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			break // closed or timed out; nothing more to read
		}
		var m signal
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "answer":
			answer = m.SDP
			for _, line := range strings.Split(m.SDP, "\n") {
				if strings.HasPrefix(strings.TrimSpace(line), "a=candidate:") {
					fromAnswer[strings.TrimSpace(line)] = true
				}
			}
			_ = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP})
			fmt.Printf("answer received for %s (%d bytes)\n", session, len(m.SDP))
		case "candidate":
			remote[m.Candidate] = true
			if *verbose {
				fmt.Printf("trickle [session=%q]: %s\n", m.Session, m.Candidate)
			}
		case "error":
			fmt.Fprintf(os.Stderr, "agent error: %+v\n", m)
		}
	}
	if answer == "" {
		fmt.Fprintln(os.Stderr, "no answer received")
		os.Exit(1)
	}

	// Keep reading to collect trickled candidates too.
	deadline = time.Now().Add(*wait)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			break // deadline or close: what we have is what the page would have seen
		}
		var m signal
		if json.Unmarshal(data, &m) == nil && m.Type == "candidate" {
			remote[m.Candidate] = true
		}
	}

	// Everything the page can see: the SDP's own candidate lines plus trickle.
	var lines []string
	for _, line := range strings.Split(answer, "\n") {
		if strings.HasPrefix(line, "a=candidate:") {
			lines = append(lines, strings.TrimPrefix(line, "a=candidate:"))
		}
	}
	for c := range remote {
		lines = append(lines, strings.TrimPrefix(c, "candidate:"))
	}
	seen := map[string]bool{}
	var out []string
	for _, l := range lines {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	sort.Strings(out)

	fmt.Printf("from answer SDP: %d, from trickle: %d\n", len(fromAnswer), len(remote))
	fmt.Printf("advertised candidates (%d unique):\n", len(out))
	for _, l := range out {
		f := strings.Fields(l)
		if len(f) < 6 {
			continue
		}
		// foundation component protocol priority address port typ type ...
		fmt.Printf("  %-4s %-24s %-6s\n", f[2], f[4]+":"+f[5], typeOf(f))
	}
}

func typeOf(f []string) string {
	for i, s := range f {
		if s == "typ" && i+1 < len(f) {
			return f[i+1]
		}
	}
	return "?"
}
