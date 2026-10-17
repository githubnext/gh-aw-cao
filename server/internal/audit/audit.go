// Package audit emits append-only, structured security audit events for
// administrator and hosted CLI operations. Events are JSON lines carrying a
// stable "audit" marker and event name so log pipelines can route them to a
// SIEM. Events never contain credentials; installation tokens appear only as
// GitHub's hashed_token form so they correlate with the GitHub audit log.
package audit

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
)

// Outcomes recorded on every event.
const (
	Success = "success"
	Denied  = "denied"
	Failure = "failure"
)

// Logger records audit events. A nil *Logger discards events.
type Logger struct {
	logger *slog.Logger
	mutex  sync.Mutex
}

// New writes JSON audit events to writer.
func New(writer io.Writer) *Logger {
	return &Logger{logger: slog.New(slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo}))}
}

// FromEnv writes to the file named by CAO_AUDIT_LOG (opened append-only with
// mode 0600) or, when unset, to standard error.
func FromEnv() (*Logger, error) {
	path := strings.TrimSpace(os.Getenv("CAO_AUDIT_LOG"))
	if path == "" {
		return New(os.Stderr), nil
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) // #nosec G304 G703 -- operator-configured audit path
	if err != nil {
		return nil, errors.New("CAO_AUDIT_LOG could not be opened for appending")
	}
	return New(file), nil
}

// Record emits one event. Attribute values must not contain secrets.
func (l *Logger) Record(ctx context.Context, event, outcome string, attrs ...slog.Attr) {
	if l == nil {
		return
	}
	fields := make([]slog.Attr, 0, len(attrs)+3)
	fields = append(fields, slog.String("audit", "cao"), slog.String("event", event), slog.String("outcome", outcome))
	fields = append(fields, attrs...)
	l.mutex.Lock()
	defer l.mutex.Unlock()
	l.logger.LogAttrs(context.WithoutCancel(ctx), slog.LevelInfo, "audit", fields...)
}
