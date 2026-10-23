package tunnel

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// maxSendBuffered caps how far ahead we queue onto the SCTP send buffer.
// Without a cap, a burst of multi-megabyte responses makes pion buffer
// unboundedly and the association degrades into a wedge.
const maxMuxSendBuffered = 1 * 1024 * 1024

// muxConn multiplexes many HTTP exchanges over ONE DataChannel.
//
// Incoming frames are dispatched by stream id; each stream is fed through an
// io.Pipe into http.ReadRequest, and replies are framed back out. A single
// writer goroutine serialises dc.Send calls, which pion requires.
type muxConn struct {
	dc    *webrtc.DataChannel
	log   interface{ Printf(string, ...any) }
	proxy func(*http.Request) (*http.Response, error)

	mu      sync.Mutex
	streams map[uint32]*muxStream

	sendMu sync.Mutex
}

type muxStream struct {
	writer *io.PipeWriter
	ended  bool
}

func newMuxConn(
	dc *webrtc.DataChannel,
	log interface{ Printf(string, ...any) },
	proxy func(*http.Request) (*http.Response, error),
) *muxConn {
	m := &muxConn{dc: dc, log: log, proxy: proxy, streams: make(map[uint32]*muxStream)}
	// Register synchronously, before pion starts the channel's read loop.
	// Registering later drops the first fragment: pion's readLoop checks for a
	// nil handler and silently returns.
	dc.OnMessage(m.onMessage)
	return m
}

func (m *muxConn) onMessage(msg webrtc.DataChannelMessage) {
	kind, stream, payload, err := decodeFrame(msg.Data)
	if err != nil {
		m.log.Printf("bad frame: %v", err)
		return
	}

	switch kind {
	case kindData:
		st := m.stream(stream)
		if st == nil {
			return
		}
		if _, err := st.writer.Write(payload); err != nil {
			m.log.Printf("stream %d write: %v", stream, err)
		}
	case kindEnd:
		m.mu.Lock()
		st := m.streams[stream]
		delete(m.streams, stream)
		m.mu.Unlock()
		if st != nil {
			st.ended = true
			_ = st.writer.Close()
		}
	case kindAbort:
		m.mu.Lock()
		st := m.streams[stream]
		delete(m.streams, stream)
		m.mu.Unlock()
		if st != nil {
			_ = st.writer.CloseWithError(errors.New("peer aborted the stream"))
		}
	default:
		m.log.Printf("unknown frame kind %d", kind)
	}
}

// stream returns (creating on demand) the pipe writer for a stream id.
func (m *muxConn) stream(id uint32) *muxStream {
	m.mu.Lock()
	defer m.mu.Unlock()
	if st, ok := m.streams[id]; ok {
		return st
	}
	pr, pw := io.Pipe()
	st := &muxStream{writer: pw}
	m.streams[id] = st
	go m.serveStream(id, pr)
	return st
}

// send writes one framed message, serialised against other streams.
func (m *muxConn) send(kind uint8, stream uint32, payload []byte) error {
	m.sendMu.Lock()
	defer m.sendMu.Unlock()
	for m.dc.BufferedAmount() > maxMuxSendBuffered {
		time.Sleep(5 * time.Millisecond)
	}
	return m.dc.Send(encodeFrame(kind, stream, payload))
}

// serveStream reads one HTTP request off the stream and answers it.
func (m *muxConn) serveStream(id uint32, pr *io.PipeReader) {
	defer func() { _ = pr.Close() }()

	req, err := http.ReadRequest(bufio.NewReader(pr))
	if err != nil {
		if !errors.Is(err, io.EOF) {
			m.log.Printf("stream %d read request: %v", id, err)
			_ = m.send(kindAbort, id, []byte("read request: "+err.Error()))
		}
		return
	}
	req.RequestURI = ""
	defer func() { _ = req.Body.Close() }()

	// The agent needs the proxy to see the public Host so vhost-based backends
	// keep working; request rewriting happens in proxy.
	resp, err := m.proxy(req)
	if err != nil {
		m.log.Printf("stream %d proxy: %v", id, err)
		resp = simpleResponse(http.StatusBadGateway, "upstream error: "+err.Error())
	}
	defer func() { _ = resp.Body.Close() }()

	if err := m.writeResponse(id, resp); err != nil {
		m.log.Printf("stream %d write response: %v", id, err)
		_ = m.send(kindAbort, id, []byte(err.Error()))
	}
}

// writeResponse streams the serialized response out as DATA frames, then END.
func (m *muxConn) writeResponse(id uint32, resp *http.Response) error {
	pr, pw := io.Pipe()
	errCh := make(chan error, 1)
	go func() {
		bw := bufio.NewWriterSize(pw, maxPayload)
		err := resp.Write(bw)
		if err == nil {
			err = bw.Flush()
		}
		_ = pw.CloseWithError(err)
		errCh <- err
	}()

	buf := make([]byte, maxPayload)
	var sendErr error
	for {
		n, err := pr.Read(buf)
		if n > 0 {
			if e := m.send(kindData, id, buf[:n]); e != nil {
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
	return m.send(kindEnd, id, nil)
}

func simpleResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Content-Type": {"text/plain; charset=utf-8"}},
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}
