package audit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type gatedMirrorWriter struct {
	entered chan struct{}
	release chan struct{}
	exited  chan struct{}
	calls   atomic.Int32
}

func (w *gatedMirrorWriter) Write(data []byte) (int, error) {
	if w.calls.Add(1) == 1 {
		close(w.entered)
		<-w.release
		close(w.exited)
	}
	return len(data), nil
}

func TestMirrorTimeoutBoundsCanceledCleanupAndConcurrentCopies(t *testing.T) {
	writer := &gatedMirrorWriter{entered: make(chan struct{}), release: make(chan struct{}), exited: make(chan struct{})}
	var unblock sync.Once
	release := func() { unblock.Do(func() { close(writer.release) }) }
	defer release()
	store := &recordingStore{}
	logger := New(writer).WithStore(store)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	done := make(chan error, 1)
	started := time.Now()
	go func() { done <- logger.Record(canceled, "token.revoked", Success) }()
	<-writer.entered
	err := <-done
	if !errors.Is(err, ErrMirrorUnavailable) || !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrUnavailable) {
		t.Fatalf("mirror timeout misreported durable outcome: %v", err)
	}
	if time.Since(started) > 2*MirrorWriteTimeout || len(store.events) != 1 {
		t.Fatalf("cleanup blocked or durable event missing: elapsed=%v events=%d", time.Since(started), len(store.events))
	}
	var group sync.WaitGroup
	for range 32 {
		group.Go(func() {
			started := time.Now()
			// Copying a logger must not create more blocked writer goroutines.
			err := logger.WithStore(nil).Record(t.Context(), "admin.denied", Denied)
			if !errors.Is(err, ErrMirrorUnavailable) || time.Since(started) > 2*MirrorWriteTimeout {
				t.Errorf("backpressure was not bounded and surfaced: %v", err)
			}
		})
	}
	group.Wait()
	if calls := writer.calls.Load(); calls != 1 {
		t.Fatalf("blocked mirror spawned %d writes, expected one", calls)
	}
	release()
	<-writer.exited
	if err := logger.Record(t.Context(), "token.revoked", Success); err != nil {
		t.Fatalf("mirror did not recover after writer resumed: %v", err)
	}
}

type failedMirrorWriter struct{ short bool }

func (w failedMirrorWriter) Write(data []byte) (int, error) {
	if w.short {
		return len(data) - 1, nil
	}
	return 0, fmt.Errorf("sensitive writer detail")
}

func TestMirrorSurfacesErrorsAndShortWritesWithoutLeakingDetails(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(fmt.Sprintf("short=%t", short), func(t *testing.T) {
			store := &recordingStore{}
			logger := New(failedMirrorWriter{short: short}).WithStore(store)
			err := logger.Record(t.Context(), "token.minted", Success)
			if !errors.Is(err, ErrMirrorUnavailable) || errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("mirror error was hidden or exposed payloads: %v", err)
			}
			if len(store.events) != 1 {
				t.Fatal("mirror failure undid or duplicated the durable append")
			}
			store.err = io.ErrClosedPipe
			err = logger.Record(t.Context(), "token.revoked", Success)
			if !errors.Is(err, ErrUnavailable) || !errors.Is(err, ErrMirrorUnavailable) || !errors.Is(err, io.ErrClosedPipe) {
				t.Fatalf("combined failures lost their classifications: %v", err)
			}
		})
	}
}

func TestMirrorFailureAfterAtomicCommitDoesNotReplayPersistence(t *testing.T) {
	logger := New(failedMirrorWriter{}).WithStore(&recordingStore{})
	var commits int
	err := logger.RecordAtomic(t.Context(), "cli_command.admitted", Success,
		func(_ context.Context, event operational.AuditEvent) (operational.AuditEvent, error) {
			commits++
			event.Sequence = 1
			return event, nil
		})
	if !errors.Is(err, ErrMirrorUnavailable) || errors.Is(err, ErrUnavailable) || commits != 1 {
		t.Fatalf("atomic mirror failure reclassified/replayed commit: commits=%d err=%v", commits, err)
	}
}

func TestMirrorSerializesCompleteJSONLines(t *testing.T) {
	var buffer bytes.Buffer
	logger := New(&buffer)
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			if err := logger.Record(t.Context(), "admin.denied", Denied); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	if lines := bytes.Split(bytes.TrimSpace(buffer.Bytes()), []byte("\n")); len(lines) != 8 {
		t.Fatalf("mirror lost concurrent lines: %s", buffer.String())
	}
}
