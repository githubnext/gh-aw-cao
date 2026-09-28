package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestMCPToolCallsEmitSemanticSpansWithoutContent(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(t.Context())
		otel.SetTracerProvider(previousProvider)
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
	if !span.Parent.IsValid() || span.Parent.TraceID() != span.SpanContext.TraceID() {
		t.Fatal("MCP span is not linked to its HTTP server span")
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
