package telemetry

import (
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// tracerName is the standardized instrumentation scope name for spans the
// dashboard server starts directly (as opposed to spans created by
// otelhttp's automatic HTTP server instrumentation).
const tracerName = "github.com/githubnext/gh-aw-cao/server"

// Tracer returns the dashboard server's instrumentation-scoped tracer. It
// always resolves against the current global TracerProvider, so it reflects
// whichever provider Setup installed (or the no-op default).
func Tracer() trace.Tracer {
	return otel.Tracer(tracerName)
}

// TraceIDHeader and SpanIDHeader expose the active W3C Trace Context
// identifiers on API responses so operators can correlate a client-visible
// request with exported spans even when the client did not send its own
// traceparent header.
const (
	TraceIDHeader = "X-Trace-Id"
	SpanIDHeader  = "X-Span-Id"
)

// SetResponseTraceHeaders writes the current span's trace and span ids, when
// valid, onto the response so operators can correlate a request with
// exported telemetry. It is a no-op when the context carries no valid span
// context, which keeps it safe to call unconditionally.
func SetResponseTraceHeaders(response http.ResponseWriter, spanContext trace.SpanContext) {
	if !spanContext.IsValid() {
		return
	}
	response.Header().Set(TraceIDHeader, spanContext.TraceID().String())
	response.Header().Set(SpanIDHeader, spanContext.SpanID().String())
}
