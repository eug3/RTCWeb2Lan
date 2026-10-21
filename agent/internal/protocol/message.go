// Package protocol defines the signaling messages exchanged between the
// browser page and this agent.
//
// Signaling is CONTROL PLANE ONLY. It carries SDP and ICE candidates so the two
// peers can find each other; business data never traverses it.
package protocol

import "encoding/json"

const Version = 1

// Type values.
const (
	TypeHello     = "hello"
	TypeReady     = "ready"
	TypeOffer     = "offer"
	TypeAnswer    = "answer"
	TypeCandidate = "candidate"
	TypeBye       = "bye"
	TypeError     = "error"
)

// Message is the wire format. Fields are optional depending on Type.
type Message struct {
	V         int     `json:"v"`
	Type      string  `json:"type"`
	Session   string  `json:"session,omitempty"`
	Role      string  `json:"role,omitempty"`
	SDP       string  `json:"sdp,omitempty"`
	Candidate string  `json:"candidate,omitempty"`
	SDPMid    string  `json:"sdpMid,omitempty"`
	SDPMIndex *uint16 `json:"sdpMLineIndex,omitempty"`
	Message   string  `json:"message,omitempty"`
}

// New builds a message with the current protocol version.
func New(typ, session string) Message {
	return Message{V: Version, Type: typ, Session: session}
}

// Marshal encodes a message.
func Marshal(m Message) ([]byte, error) { return json.Marshal(m) }

// Unmarshal decodes a message, tolerating unknown fields.
func Unmarshal(b []byte) (Message, error) {
	var m Message
	err := json.Unmarshal(b, &m)
	return m, err
}
