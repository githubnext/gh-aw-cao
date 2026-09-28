package server

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

const (
	mcpMethodNameKey      = "mcp.method.name"
	mcpProtocolVersionKey = "mcp.protocol.version"
	mcpSessionIDKey       = "mcp.session.id"
	genAIToolNameKey      = "gen_ai.tool.name"
	genAIOperationNameKey = "gen_ai.operation.name"
	errorTypeKey          = "error.type"
	rpcStatusCodeKey      = "rpc.response.status_code"
)

func mcpServerTelemetry() mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			spanName := method
			attributes := []attribute.KeyValue{
				attribute.String(mcpMethodNameKey, method),
				attribute.String("network.transport", "tcp"),
				attribute.String("network.protocol.name", "http"),
			}
			if toolName := mcpToolName(request); toolName != "" {
				spanName += " " + toolName
				attributes = append(attributes,
					attribute.String(genAIToolNameKey, toolName),
					attribute.String(genAIOperationNameKey, "execute_tool"),
				)
			}
			if protocolVersion := mcpRequestProtocolVersion(request); protocolVersion != "" {
				attributes = append(attributes, attribute.String(mcpProtocolVersionKey, protocolVersion))
			}
			if session := request.GetSession(); session != nil && session.ID() != "" {
				attributes = append(attributes, attribute.String(mcpSessionIDKey, session.ID()))
			}

			parentContext, links := mcpParentContext(ctx, request)
			parentContext, span := telemetry.Tracer().Start(parentContext, spanName,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(attributes...),
				trace.WithLinks(links...),
			)
			defer span.End()

			result, err := next(parentContext, method, request)
			if err != nil {
				recordMCPServerError(span, err)
			} else if toolResult, ok := result.(*mcp.CallToolResult); ok && toolResult.IsError {
				span.SetAttributes(attribute.String(errorTypeKey, "tool_error"))
				span.SetStatus(codes.Error, "MCP tool call failed")
			}
			return result, err
		}
	}
}

func mcpParentContext(ambient context.Context, request mcp.Request) (context.Context, []trace.Link) {
	return mcpTraceContext(ambient, request.GetParams().GetMeta())
}

func mcpTraceContext(ambient context.Context, metadata map[string]any) (context.Context, []trace.Link) {
	carrier := propagation.MapCarrier{}
	for _, key := range []string{"traceparent", "tracestate", "baggage"} {
		if value, ok := metadata[key].(string); ok {
			carrier[key] = value
		}
	}
	parent := trace.ContextWithSpanContext(ambient, trace.SpanContext{})
	parent = baggage.ContextWithBaggage(parent, baggage.Baggage{})
	parent = otel.GetTextMapPropagator().Extract(parent, carrier)
	if spanContext := trace.SpanContextFromContext(ambient); spanContext.IsValid() {
		return parent, []trace.Link{{SpanContext: spanContext}}
	}
	return parent, nil
}

func recordMCPServerError(span trace.Span, err error) {
	var rpcError *jsonrpc.Error
	if errors.As(err, &rpcError) {
		code := strconv.FormatInt(rpcError.Code, 10)
		span.SetAttributes(attribute.String(rpcStatusCodeKey, code))
		if isMCPCallerError(rpcError.Code) {
			return
		}
		span.SetAttributes(attribute.String(errorTypeKey, code))
	} else {
		span.SetAttributes(attribute.String(errorTypeKey, fmt.Sprintf("%T", err)))
	}
	span.RecordError(err)
	span.SetStatus(codes.Error, "MCP request failed")
}

func isMCPCallerError(code int64) bool {
	switch code {
	case jsonrpc.CodeParseError, jsonrpc.CodeInvalidRequest, jsonrpc.CodeMethodNotFound,
		jsonrpc.CodeInvalidParams:
		return true
	default:
		return false
	}
}

func mcpToolName(request mcp.Request) string {
	var name string
	switch params := request.GetParams().(type) {
	case *mcp.CallToolParams:
		name = params.Name
	case *mcp.CallToolParamsRaw:
		name = params.Name
	}
	if name == "cao_catalog" || name == "cao_query" {
		return name
	}
	return ""
}

func mcpRequestProtocolVersion(request mcp.Request) string {
	versioned, ok := request.(interface{ ProtocolVersion() string })
	if !ok {
		return ""
	}
	return versioned.ProtocolVersion()
}
