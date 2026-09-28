package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestMCPToolCallsEmitSemanticSpansWithoutContent(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	t.Cleanup(func() {
		_ = provider.Shutdown(t.Context())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})

	app := newMCPTestApp(t, true)
	httpServer := httptest.NewServer(app.Handler())
	defer httpServer.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{
			token: testAccessToken, base: http.DefaultTransport,
		}},
	}, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Close() }()
	exporter.Reset()

	success, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Meta: mcp.Meta{
			"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		},
		Name: "cao_catalog", Arguments: map[string]any{"kind": "queries"},
	})
	if err != nil || success.IsError {
		t.Fatalf("successful tool call returned result=%#v err=%v", success, err)
	}
	failure, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name: "cao_query", Arguments: map[string]any{"id": "not-a-query"},
	})
	if err != nil || !failure.IsError {
		t.Fatalf("failing tool call returned result=%#v err=%v", failure, err)
	}
	_, _ = session.CallTool(t.Context(), &mcp.CallToolParams{Name: "client-controlled-name"})

	successSpan := findSpan(t, exporter.GetSpans(), "tools/call cao_catalog")
	assertMCPToolSpan(t, successSpan, "cao_catalog")
	if successSpan.Status.Code != codes.Unset {
		t.Fatalf("successful span status = %v, want unset", successSpan.Status.Code)
	}
	if successSpan.Parent.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		successSpan.Parent.SpanID().String() != "00f067aa0ba902b7" ||
		!successSpan.Parent.IsRemote() {
		t.Fatalf("MCP span parent = %v, want remote params._meta trace context", successSpan.Parent)
	}

	failureSpan := findSpan(t, exporter.GetSpans(), "tools/call cao_query")
	assertMCPToolSpan(t, failureSpan, "cao_query")
	if failureSpan.Status.Code != codes.Error {
		t.Fatalf("failed span status = %v, want error", failureSpan.Status.Code)
	}
	if got := spanAttributes(failureSpan.Attributes)[errorTypeKey]; got != "tool_error" {
		t.Fatalf("failed span error.type = %#v, want tool_error", got)
	}

	unknownSpan := findSpan(t, exporter.GetSpans(), "tools/call")
	if _, ok := spanAttributes(unknownSpan.Attributes)[genAIToolNameKey]; ok {
		t.Fatal("an unknown client-controlled tool name must not become a telemetry attribute")
	}
	if unknownSpan.Status.Code != codes.Unset {
		t.Fatalf("unknown tool span status = %v, want unset caller error", unknownSpan.Status.Code)
	}
	if got := spanAttributes(unknownSpan.Attributes)[rpcStatusCodeKey]; got != "-32602" {
		t.Fatalf("unknown tool rpc.response.status_code = %#v, want -32602", got)
	}
}

func TestMCPTraceContextPreservesCancellation(t *testing.T) {
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(previousPropagator) })

	ambientTraceID, _ := trace.TraceIDFromHex("11111111111111111111111111111111")
	ambientSpanID, _ := trace.SpanIDFromHex("1111111111111111")
	ambientSpan := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: ambientTraceID, SpanID: ambientSpanID,
	})
	ambient, cancel := context.WithCancel(trace.ContextWithSpanContext(t.Context(), ambientSpan))
	parent, links := mcpTraceContext(ambient, map[string]any{
		"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
	})
	cancel()

	select {
	case <-parent.Done():
	default:
		t.Fatal("MCP context did not preserve ambient request cancellation")
	}
	if got := trace.SpanContextFromContext(parent); got.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		!got.IsRemote() {
		t.Fatalf("MCP parent context = %v, want extracted remote context", got)
	}
	if len(links) != 1 ||
		links[0].SpanContext.TraceID() != ambientSpan.TraceID() ||
		links[0].SpanContext.SpanID() != ambientSpan.SpanID() {
		t.Fatalf("MCP transport links = %#v, want ambient span", links)
	}
}

func findSpan(t *testing.T, spans tracetest.SpanStubs, name string) tracetest.SpanStub {
	t.Helper()
	for _, span := range spans {
		if span.Name == name {
			return span
		}
	}
	t.Fatalf("span %q not found in %#v", name, spans)
	return tracetest.SpanStub{}
}

func assertMCPToolSpan(t *testing.T, span tracetest.SpanStub, toolName string) {
	t.Helper()
	if span.SpanKind != trace.SpanKindServer {
		t.Fatalf("span kind = %v, want server", span.SpanKind)
	}
	if len(span.Links) != 1 || !span.Links[0].SpanContext.IsValid() {
		t.Fatal("MCP span does not link its ambient HTTP server span")
	}
	attributes := spanAttributes(span.Attributes)
	for key, want := range map[string]any{
		mcpMethodNameKey:        "tools/call",
		mcpProtocolVersionKey:   "2026-07-28",
		genAIToolNameKey:        toolName,
		genAIOperationNameKey:   "execute_tool",
		"network.transport":     "tcp",
		"network.protocol.name": "http",
	} {
		if got := attributes[key]; got != want {
			t.Errorf("%s = %#v, want %#v", key, got, want)
		}
	}
	for _, key := range []string{"gen_ai.tool.call.arguments", "gen_ai.tool.call.result"} {
		if _, ok := attributes[key]; ok {
			t.Errorf("sensitive content attribute %s must be absent", key)
		}
	}
}

func spanAttributes(attributes []attribute.KeyValue) map[string]any {
	result := make(map[string]any, len(attributes))
	for _, item := range attributes {
		result[string(item.Key)] = item.Value.AsInterface()
	}
	return result
}
