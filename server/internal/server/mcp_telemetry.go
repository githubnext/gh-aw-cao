package server

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
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

			ctx, span := telemetry.Tracer().Start(ctx, spanName,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(attributes...),
			)
			defer span.End()

			result, err := next(ctx, method, request)
			if err != nil {
				span.RecordError(err)
				span.SetAttributes(attribute.String(errorTypeKey, fmt.Sprintf("%T", err)))
				span.SetStatus(codes.Error, "MCP request failed")
			} else if toolResult, ok := result.(*mcp.CallToolResult); ok && toolResult.IsError {
				span.SetAttributes(attribute.String(errorTypeKey, "tool_error"))
				span.SetStatus(codes.Error, "MCP tool call failed")
			}
			return result, err
		}
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
