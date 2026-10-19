package server

import (
	"bufio"
	"crypto/sha1" // #nosec G505 -- RFC 6455 requires SHA-1 for the WebSocket handshake.
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var localTraceID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

type localSocket struct {
	connection net.Conn
	mu         sync.Mutex
}

func (s *localSocket) write(opcode byte, content []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.connection.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	header := []byte{0x80 | opcode}
	switch {
	case len(content) < 126:
		header = append(header, byte(len(content)&0x7f))
	case len(content) <= 65535:
		header = binary.BigEndian.AppendUint16(append(header, 126), uint16(len(content)&0xffff))
	default:
		header = binary.BigEndian.AppendUint64(append(header, 127), uint64(len(content)))
	}
	buffers := net.Buffers{header, content}
	_, err := buffers.WriteTo(s.connection)
	return err
}

func (s *LocalServer) websocket(w http.ResponseWriter, r *http.Request) {
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	origin := r.Header.Get("Origin")
	if r.Method != http.MethodGet || r.URL.RawQuery != "" ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" || err != nil || len(key) != 16 ||
		origin == "" && !s.config.AllowMissingOrigin || origin != "" && !s.allowedOrigin(origin) {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	connection, buffer, err := hijacker.Hijack()
	if err != nil {
		serverLog.Printf("local socket handshake failed")
		return
	}
	defer func() { _ = connection.Close() }()
	// #nosec G401 -- this is the mandated RFC 6455 handshake, not a signature.
	digest := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(digest[:])
	if _, err := buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"); err != nil {
		return
	}
	if err := buffer.Flush(); err != nil {
		return
	}
	socket := &localSocket{connection: connection}
	s.mu.Lock()
	s.sockets[socket] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.sockets, socket)
		s.mu.Unlock()
	}()
	for {
		opcode, content, err := readLocalFrame(buffer.Reader)
		if err != nil {
			_ = socket.write(8, nil)
			return
		}
		switch opcode {
		case 1:
			if err := s.browserTrace(content); err != nil {
				_ = socket.write(8, nil)
				return
			}
		case 8:
			_ = socket.write(8, nil)
			return
		case 9:
			if err := socket.write(10, content); err != nil {
				return
			}
		case 10:
			continue
		default:
			_ = socket.write(8, nil)
			return
		}
	}
}

func (s *LocalServer) browserTrace(content []byte) error {
	var message struct {
		Type    string `json:"type"`
		TraceID string `json:"traceId"`
		Event   string `json:"event"`
		Details struct {
			PageCount int   `json:"pageCount"`
			Recovered *bool `json:"recovered"`
		} `json:"details"`
	}
	if !utf8.Valid(content) || json.Unmarshal(content, &message) != nil ||
		message.Type != "browser.trace" || !localTraceID.MatchString(message.TraceID) ||
		(message.Event != "preview.rendered" && message.Event != "preview.render.failed") ||
		message.Details.PageCount < 0 || message.Details.PageCount > 10000 {
		return errors.New("invalid browser trace")
	}
	if s.config.OnBrowserTrace != nil {
		details := map[string]any{"pageCount": message.Details.PageCount}
		if message.Details.Recovered != nil {
			details["recovered"] = *message.Details.Recovered
		}
		redacted, ok := localRedactJSON(map[string]any{
			"type": "browser.trace", "traceId": message.TraceID, "event": message.Event, "details": details,
		}).(map[string]any)
		if !ok {
			return errors.New("invalid browser trace metadata")
		}
		s.config.OnBrowserTrace(redacted)
	}
	return nil
}

func readLocalFrame(reader *bufio.Reader) (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return 0, nil, err
	}
	opcode := header[0] & 15
	length := uint64(header[1] & 127)
	if header[0]&0xf0 != 0x80 || header[1]&0x80 == 0 ||
		(opcode != 1 && opcode != 8 && opcode != 9 && opcode != 10) ||
		opcode != 1 && length > 125 {
		return 0, nil, errors.New("unsupported WebSocket frame")
	}
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
		if length < 126 {
			return 0, nil, errors.New("noncanonical WebSocket frame length")
		}
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(extended[:])
		if length < 65536 {
			return 0, nil, errors.New("noncanonical WebSocket frame length")
		}
	}
	if length > 64<<10 || opcode == 1 && length == 0 {
		return 0, nil, errors.New("WebSocket frame exceeds the supported message bounds")
	}
	mask := make([]byte, 4)
	if _, err := io.ReadFull(reader, mask); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, nil, err
	}
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	return opcode, payload, nil
}
