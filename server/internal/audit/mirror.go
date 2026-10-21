package audit

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"
)

// MirrorWriteTimeout includes waiting for any preceding mirror write. An
// arbitrary io.Writer cannot be canceled; one shared slot bounds outstanding
// I/O even when it never returns. WithStore copies share this slot.
const MirrorWriteTimeout = 250 * time.Millisecond

type mirror struct {
	writer io.Writer
	active chan struct{}
}

func (m *mirror) write(ctx context.Context, fields []slog.Attr) (err error) {
	ctx, cancel := context.WithTimeout(ctx, MirrorWriteTimeout)
	defer cancel()
	reason := "success"
	defer func() {
		if reason != "success" {
			auditLog.Printf("mirror write unconfirmed: reason=%s", reason)
		}
		observeMirror(context.WithoutCancel(ctx), reason)
	}()
	select {
	case m.active <- struct{}{}:
	case <-ctx.Done():
		reason = "timeout"
		return fmt.Errorf("%w: %w", ErrMirrorUnavailable, ctx.Err())
	}
	// Encode before dispatch so the background writer retains only immutable
	// bytes, never caller-owned attributes or mutable structured values.
	var buffer bytes.Buffer
	record := slog.NewRecord(time.Now(), slog.LevelInfo, "audit", 0)
	record.AddAttrs(fields...)
	if err := slog.NewJSONHandler(&buffer, nil).Handle(ctx, record); err != nil {
		<-m.active
		reason = "error"
		return ErrMirrorUnavailable
	}
	if err := ctx.Err(); err != nil {
		<-m.active
		reason = "timeout"
		return fmt.Errorf("%w: %w", ErrMirrorUnavailable, err)
	}
	data := buffer.Bytes()
	done := make(chan error, 1)
	go func() {
		defer func() { <-m.active }()
		n, err := m.writer.Write(data)
		if err != nil || n != len(data) {
			// Writer errors may contain payloads; expose only a stable,
			// credential-free failure classification.
			done <- ErrMirrorUnavailable
			return
		}
		done <- nil
	}()
	select {
	case err := <-done:
		if err != nil {
			reason = "error"
		}
		return err
	case <-ctx.Done():
		reason = "timeout"
		return fmt.Errorf("%w: %w", ErrMirrorUnavailable, ctx.Err())
	}
}
