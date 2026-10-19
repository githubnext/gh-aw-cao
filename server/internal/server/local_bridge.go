package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// LocalBridge connects optional workspace tooling and trusted SDK callbacks over
// private process pipes. It never opens a second HTTP listener.
type LocalBridge struct {
	writer  io.Writer
	writeMu sync.Mutex
	mu      sync.Mutex
	next    atomic.Uint64
	pending map[uint64]chan localReply
	done    chan struct{}
	err     error
	events  func(json.RawMessage)
}

type localReply struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *localError     `json:"error,omitempty"`
	Event  string          `json:"event,omitempty"`
}

type localError struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
}

func (e *localError) Error() string { return e.Message }

func NewLocalBridge(input io.Reader, output io.Writer, events func(json.RawMessage)) *LocalBridge {
	bridge := &LocalBridge{
		writer: output, pending: map[uint64]chan localReply{}, done: make(chan struct{}), events: events,
	}
	go bridge.read(input)
	return bridge
}

func (b *LocalBridge) read(input io.Reader) {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64<<10), 32<<20)
	for scanner.Scan() {
		var reply localReply
		if err := json.Unmarshal(scanner.Bytes(), &reply); err != nil {
			b.fail(errors.New("invalid local tooling response"))
			return
		}
		if reply.Event != "" {
			if b.events != nil {
				b.events(append(json.RawMessage{}, scanner.Bytes()...))
			}
			continue
		}
		b.mu.Lock()
		channel := b.pending[reply.ID]
		delete(b.pending, reply.ID)
		b.mu.Unlock()
		if channel != nil {
			channel <- reply
		}
	}
	err := scanner.Err()
	if err == nil {
		err = errors.New("local tooling disconnected")
	}
	b.fail(err)
}

func (b *LocalBridge) fail(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return
	}
	b.err = err
	close(b.done)
}

func (b *LocalBridge) Notify(value any) error {
	content, err := json.Marshal(value)
	if err != nil {
		return err
	}
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	_, err = fmt.Fprintf(b.writer, "%s\n", content)
	return err
}

func (b *LocalBridge) Call(ctx context.Context, operation string, payload any, result any) error {
	id := b.next.Add(1)
	channel := make(chan localReply, 1)
	b.mu.Lock()
	if b.err != nil {
		err := b.err
		b.mu.Unlock()
		return err
	}
	b.pending[id] = channel
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()
	if err := b.Notify(map[string]any{"id": id, "operation": operation, "payload": payload}); err != nil {
		return err
	}
	select {
	case reply := <-channel:
		if reply.Error != nil {
			return reply.Error
		}
		if result != nil {
			return json.Unmarshal(reply.Result, result)
		}
		return nil
	case <-ctx.Done():
		if err := b.Notify(map[string]any{"cancel": id}); err != nil {
			return fmt.Errorf("cancel local tooling: %w", err)
		}
		return ctx.Err()
	case <-b.done:
		return errors.New("local tooling is unavailable")
	}
}
