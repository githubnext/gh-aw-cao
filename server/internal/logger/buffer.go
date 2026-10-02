package logger

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
)

const bufferCapacity = 10_000
const maxMessageBytes = 4096

// Buffer retains a bounded snapshot of recent server debug records.
type Buffer struct {
	mu    sync.Mutex
	lines [bufferCapacity][]byte
	next  int
	count int
}

var activeBuffer atomic.Pointer[Buffer]

// EnableBuffer starts retaining server debug logs. Existing loggers use it immediately.
func EnableBuffer() *Buffer {
	if buffer := activeBuffer.Load(); buffer != nil {
		return buffer
	}
	buffer := new(Buffer)
	if activeBuffer.CompareAndSwap(nil, buffer) {
		return buffer
	}
	return activeBuffer.Load()
}

func (b *Buffer) append(timestamp time.Time, namespace, message string) {
	if len(message) > maxMessageBytes {
		message = message[:maxMessageBytes]
	}
	line, err := json.Marshal(struct {
		Timestamp string `json:"timestamp"`
		Namespace string `json:"namespace"`
		Message   string `json:"message"`
	}{timestamp.UTC().Format(time.RFC3339Nano), namespace, message})
	if err != nil {
		return
	}
	b.mu.Lock()
	b.lines[b.next] = line
	b.next = (b.next + 1) % bufferCapacity
	if b.count < bufferCapacity {
		b.count++
	}
	b.mu.Unlock()
}

// Snapshot returns the retained JSONL records in chronological order.
func (b *Buffer) Snapshot() [][]byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := make([][]byte, b.count)
	for i := range lines {
		lines[i] = b.lines[(b.next-b.count+i+bufferCapacity)%bufferCapacity]
	}
	return lines
}
