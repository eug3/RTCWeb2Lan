package tunnel

import (
	"encoding/binary"
	"errors"
)

// Multiplexing over a single DataChannel.
//
// One DataChannel per HTTP request meant every request paid for a fresh SCTP
// stream: a DCEP handshake that Chrome and pion often never complete, plus
// stream resets that poison later streams on the same association. In
// production that failed for nearly every request, so the overlay degraded to
// the fallback proxy without saying so.
//
// This keeps ONE channel open and multiplexes requests over it:
//
//	┌────────────┬──────────────┬──────────────────────────┐
//	│ kind (u8)  │ stream (u32) │ payload (0..maxPayload)  │
//	└────────────┴──────────────┴──────────────────────────┘
//
// Frames for different streams interleave freely. A stream's body is
// terminated by an END frame, which replaces the old "empty message" marker.
//
// The browser speaks the same protocol (fdn/web/src/mux.ts); keep them in sync.

const (
	// frameHeader is kind(1) + stream(4).
	frameHeader = 5
	// maxPayload is the largest payload a single frame may carry.
	maxPayload = MTU - frameHeader
)

// Frame kinds.
const (
	kindData  = 1
	kindEnd   = 2
	kindAbort = 3
)

// Exported aliases and helpers so tests (and any other package) can speak the
// same wire format without duplicating the constants.
const (
	KindData  = kindData
	KindEnd   = kindEnd
	KindAbort = kindAbort
)

// EncodeFrame is the exported form of encodeFrame.
func EncodeFrame(kind uint8, stream uint32, payload []byte) []byte {
	return encodeFrame(kind, stream, payload)
}

// DecodeFrame is the exported form of decodeFrame.
func DecodeFrame(data []byte) (uint8, uint32, []byte, error) {
	return decodeFrame(data)
}

// FragmentPayload splits a payload into frame-sized pieces.
func FragmentPayload(payload []byte) [][]byte {
	var out [][]byte
	for offset := 0; offset < len(payload); offset += maxPayload {
		end := offset + maxPayload
		if end > len(payload) {
			end = len(payload)
		}
		out = append(out, payload[offset:end])
	}
	return out
}

var errShortFrame = errors.New("frame shorter than header")

// encodeFrame builds a framed message. The caller owns the returned slice.
func encodeFrame(kind uint8, stream uint32, payload []byte) []byte {
	buf := make([]byte, frameHeader+len(payload))
	buf[0] = kind
	binary.BigEndian.PutUint32(buf[1:5], stream)
	copy(buf[frameHeader:], payload)
	return buf
}

// decodeFrame splits a message into its header and payload.
// The payload aliases the input buffer.
func decodeFrame(data []byte) (kind uint8, stream uint32, payload []byte, err error) {
	if len(data) < frameHeader {
		return 0, 0, nil, errShortFrame
	}
	return data[0], binary.BigEndian.Uint32(data[1:5]), data[frameHeader:], nil
}
