package redisx

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

type redisOperation struct {
	started  time.Time
	span     trace.Span
	duration metric.Float64Histogram
	attrs    []attribute.KeyValue
}

func (c *Client) startOperation(ctx context.Context, command string, batchSize int) (context.Context, redisOperation) {
	started := time.Now()
	attrs := []attribute.KeyValue{
		semconv.DBSystemNameRedis,
		semconv.DBOperationName(command),
	}
	ctx, span := telemetry.Tracer().Start(ctx, command,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithTimestamp(started),
		trace.WithAttributes(attrs...))
	if batchSize >= 0 {
		span.SetAttributes(semconv.DBOperationBatchSize(batchSize))
	}
	return ctx, redisOperation{started: started, span: span, duration: c.duration, attrs: attrs}
}

func (operation redisOperation) finish(ctx context.Context, err error) {
	ended := time.Now()
	if err != nil {
		operation.attrs = append(operation.attrs, redisErrorAttributes(err)...)
		operation.span.SetAttributes(operation.attrs...)
		operation.span.SetStatus(codes.Error, "redis operation failed")
	}
	operation.duration.Record(ctx, ended.Sub(operation.started).Seconds(), metric.WithAttributes(operation.attrs...))
	operation.span.End(trace.WithTimestamp(ended))
}

func redisCommandName(args []string) string {
	if len(args) == 0 {
		return "_OTHER"
	}
	switch command := strings.ToUpper(args[0]); command {
	case "AUTH", "SELECT", "PING", "INFO", "GET", "SET", "DEL", "UNLINK", "EXISTS",
		"EXPIRE", "PEXPIRE", "TTL", "PTTL", "TIME", "EVAL", "EVALSHA",
		"HGET", "HGETALL", "HMGET", "HSET", "HDEL", "HLEN", "HINCRBY",
		"SMEMBERS", "SADD", "SREM", "SISMEMBER", "SCARD", "SSCAN", "SCAN",
		"ZADD", "ZREM", "ZCARD", "ZSCORE", "ZRANGE", "ZRANGEBYSCORE",
		"XADD", "XACK", "XAUTOCLAIM", "XGROUP", "XINFO", "XLEN", "XPENDING", "XREADGROUP",
		"LPUSH", "LPOP", "LLEN", "MEMORY":
		return command
	default:
		return "_OTHER"
	}
}

func redisPipelineName(commands [][]string) (string, int) {
	if len(commands) == 1 {
		return redisCommandName(commands[0]), -1
	}
	if len(commands) > 1 {
		command := redisCommandName(commands[0])
		if command != "_OTHER" {
			same := true
			for _, args := range commands[1:] {
				if redisCommandName(args) != command {
					same = false
					break
				}
			}
			if same {
				return "PIPELINE " + command, len(commands)
			}
		}
	}
	return "PIPELINE", len(commands)
}

func redisErrorAttributes(err error) []attribute.KeyValue {
	var responseError redisResponseError
	if errors.As(err, &responseError) {
		code, _, _ := strings.Cut(responseError.message, " ")
		switch code {
		case "ERR", "WRONGTYPE", "NOAUTH", "NOPERM", "OOM", "BUSY", "LOADING",
			"READONLY", "MASTERDOWN", "CLUSTERDOWN", "CROSSSLOT", "TRYAGAIN",
			"MOVED", "ASK", "NOSCRIPT", "EXECABORT", "MISCONF":
			return []attribute.KeyValue{
				semconv.DBResponseStatusCode(code),
				semconv.ErrorTypeKey.String(code),
			}
		}
	}
	return []attribute.KeyValue{semconv.ErrorTypeKey.String(telemetry.DatabaseErrorType(err))}
}
