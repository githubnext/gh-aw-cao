// Package audit records append-only, structured security audit events for
// administrator and hosted CLI operations. The authoritative trail is the
// operational store's tamper-evident audit table; every event is also mirrored
// as a JSON line carrying a stable "audit" marker and exported as an
// OpenTelemetry log record named cao.audit.<event>, so log pipelines can route
// it to a SIEM. Events carry the active trace_id and span_id. Events never contain credentials; installation tokens appear only
// as GitHub's hashed_token form so they correlate with the GitHub audit log.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

// Outcomes recorded on every event.
const (
	Success = "success"
	Denied  = "denied"
	Failure = "failure"
)

// ErrUnavailable reports that an event could not be stored durably.
var ErrUnavailable = errors.New("audit trail unavailable")

// Logger records audit events. A nil *Logger discards events.
type Logger struct {
	logger *slog.Logger
	store  operational.AuditLog
	mutex  *sync.Mutex
}

// New writes JSON audit events to writer.
func New(writer io.Writer) *Logger {
	return &Logger{logger: slog.New(slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo})), mutex: &sync.Mutex{}}
}

// WithStore returns a logger that appends every event to the durable audit
// table before mirroring it to the JSON stream. A nil receiver stores without
// mirroring.
func (l *Logger) WithStore(store operational.AuditLog) *Logger {
	if l == nil {
		return &Logger{store: store, mutex: &sync.Mutex{}}
	}
	return &Logger{logger: l.logger, store: store, mutex: l.mutex}
}

// Durable reports whether events are persisted to the audit table.
func (l *Logger) Durable() bool { return l != nil && l.store != nil }

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

// Record stores one event and mirrors it to the JSON stream. It returns
// ErrUnavailable when a durable store is configured and the append fails;
// callers guarding privileged work must then fail closed. The event is still
// mirrored, marked stored=false, so the failure itself remains observable.
// Attribute values must not contain secrets.
func (l *Logger) Record(ctx context.Context, event, outcome string, attrs ...slog.Attr) error {
	if l == nil {
		return nil
	}
	attrs = append(attrs, traceAttrs(ctx)...)
	started := time.Now()
	var stored operational.AuditEvent
	var storeErr error
	if l.store != nil {
		stored, storeErr = l.store.AppendAudit(context.WithoutCancel(ctx), toEvent(event, outcome, attrs))
	}
	observe(context.WithoutCancel(ctx), event, outcome, l.store != nil && storeErr == nil, stored.Sequence, started, l.store != nil, attrs)
	if l.logger != nil {
		fields := make([]slog.Attr, 0, len(attrs)+5)
		fields = append(fields, slog.String("audit", "cao"), slog.String("event", event), slog.String("outcome", outcome))
		switch {
		case storeErr != nil:
			fields = append(fields, slog.Bool("stored", false))
		case l.store != nil:
			fields = append(fields, slog.Bool("stored", true), slog.Int64("sequence", stored.Sequence))
		}
		fields = append(fields, attrs...)
		l.mutex.Lock()
		l.logger.LogAttrs(context.WithoutCancel(ctx), slog.LevelInfo, "audit", fields...)
		l.mutex.Unlock()
	}
	if storeErr != nil {
		return fmt.Errorf("%w: %s", ErrUnavailable, event)
	}
	return nil
}

func toEvent(event, outcome string, attrs []slog.Attr) operational.AuditEvent {
	result := operational.AuditEvent{Event: event, Outcome: outcome}
	for _, attr := range attrs {
		value := attrString(attr.Value)
		if attr.Key == "actor" {
			result.Actor = value
			continue
		}
		if result.Attributes == nil {
			result.Attributes = make(map[string]string, len(attrs))
		}
		result.Attributes[attr.Key] = value
	}
	return result
}

func attrString(value slog.Value) string {
	value = value.Resolve()
	switch value.Kind() {
	case slog.KindTime:
		return value.Time().UTC().Format(time.RFC3339Nano)
	case slog.KindAny:
		if encoded, err := json.Marshal(value.Any()); err == nil {
			return string(encoded)
		}
	case slog.KindString, slog.KindInt64, slog.KindUint64, slog.KindFloat64, slog.KindBool,
		slog.KindDuration, slog.KindGroup, slog.KindLogValuer:
	}
	return value.String()
}
