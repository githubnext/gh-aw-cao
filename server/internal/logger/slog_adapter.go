package logger

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	otelLog "go.opentelemetry.io/otel/log"
)

// SlogHandler implements slog.Handler by wrapping a Logger.
type SlogHandler struct {
	logger *Logger
}

// NewSlogHandler creates a slog.Handler that wraps logger.
func NewSlogHandler(logger *Logger) *SlogHandler {
	return &SlogHandler{logger: logger}
}

// Enabled reports whether the wrapped logger is enabled.
func (h *SlogHandler) Enabled(_ context.Context, _ slog.Level) bool {
	return h.logger.Enabled()
}

// Handle formats a slog record for the wrapped logger.
func (h *SlogHandler) Handle(ctx context.Context, record slog.Record) error {
	if !h.logger.Enabled() {
		return nil
	}

	var message strings.Builder
	message.WriteString(record.Message)
	record.Attrs(func(attribute slog.Attr) bool {
		_, _ = fmt.Fprintf(&message, " %s=%s", attribute.Key, attribute.Value.String())
		return true
	})
	levelPrefix := ""
	severity := otelLog.SeverityDebug
	switch record.Level {
	case slog.LevelDebug, slog.LevelInfo:
		levelPrefix = "· "
		if record.Level == slog.LevelInfo {
			severity = otelLog.SeverityInfo
		}
	case slog.LevelWarn:
		levelPrefix = "⚠ "
		severity = otelLog.SeverityWarn
	case slog.LevelError:
		levelPrefix = "✗ "
		severity = otelLog.SeverityError
	}
	h.logger.write(ctx, severity, levelPrefix+message.String())
	return nil
}

// WithAttrs returns the handler unchanged, matching the gh-aw adapter.
func (h *SlogHandler) WithAttrs(_ []slog.Attr) slog.Handler {
	return h
}

// WithGroup returns the handler unchanged, matching the gh-aw adapter.
func (h *SlogHandler) WithGroup(_ string) slog.Handler {
	return h
}

// NewSlogLoggerWithHandler creates a slog.Logger backed by logger.
func NewSlogLoggerWithHandler(logger *Logger) *slog.Logger {
	return slog.New(NewSlogHandler(logger))
}
