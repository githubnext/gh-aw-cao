package hostedcli

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

// maxBufferedLine bounds one stream's unterminated output before it is
// flushed; it stays below the queue's 16 KiB chunk limit after redaction.
const maxBufferedLine = 8 * 1024

// outputSink line-buffers subprocess output, removes the command credential
// and secret-shaped text, and appends it to the queue.
type outputSink struct {
	ctx     context.Context
	queue   operational.CLICommandQueue
	lease   operational.CLICommandLease
	id      int64
	mutex   sync.Mutex
	buffers map[string]*bytes.Buffer
	secrets []string
	stopped bool
}

func newOutputSink(ctx context.Context, queue operational.CLICommandQueue, lease operational.CLICommandLease, id int64) *outputSink {
	return &outputSink{ctx: ctx, queue: queue, lease: lease, id: id, buffers: map[string]*bytes.Buffer{}}
}

func (s *outputSink) secret(value string) {
	if value == "" {
		return
	}
	s.mutex.Lock()
	s.secrets = append(s.secrets, value)
	s.mutex.Unlock()
}

func (s *outputSink) notice(text string) {
	s.write("stderr", []byte(text))
}

func (s *outputSink) write(stream string, data []byte) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.stopped {
		return
	}
	buffer := s.buffers[stream]
	if buffer == nil {
		buffer = &bytes.Buffer{}
		s.buffers[stream] = buffer
	}
	buffer.Write(data)
	for {
		content := buffer.Bytes()
		index := bytes.IndexByte(content, '\n')
		if index < 0 {
			if buffer.Len() < maxBufferedLine {
				return
			}
			index = maxBufferedLine - 1
			for index > 0 && !utf8.RuneStart(content[index+1]) {
				index--
			}
		}
		line := string(content[:index+1])
		buffer.Next(index + 1)
		s.appendLocked(stream, line)
	}
}

func (s *outputSink) close() {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	for _, stream := range []string{"stdout", "stderr"} {
		if buffer := s.buffers[stream]; buffer != nil && buffer.Len() > 0 {
			s.appendLocked(stream, buffer.String())
			buffer.Reset()
		}
	}
	s.stopped = true
}

func (s *outputSink) appendLocked(stream, text string) {
	if s.stopped {
		return
	}
	for _, secret := range s.secrets {
		text = strings.ReplaceAll(text, secret, "[REDACTED]")
	}
	text = operational.RedactCLICommandText(text)
	if text == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(s.ctx), 10*time.Second)
	defer cancel()
	if _, err := s.queue.AppendOutput(ctx, s.lease, s.id, stream, text); err != nil {
		// A canceled or finished command no longer accepts output.
		s.stopped = true
	}
}
