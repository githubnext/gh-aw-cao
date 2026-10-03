package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/trace"
)

func TestExtractTraceparentDropsMetadataAndPreservesCancellation(t *testing.T) {
	member, err := baggage.NewMember("account", "private-account")
	if err != nil {
		t.Fatal(err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatal(err)
	}
	state, err := trace.ParseTraceState("vendor=private-account")
	if err != nil {
		t.Fatal(err)
	}
	parentTraceID, _ := trace.TraceIDFromHex("11111111111111111111111111111111")
	parentSpanID, _ := trace.SpanIDFromHex("1111111111111111")
	parent := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: parentTraceID, SpanID: parentSpanID, TraceState: state,
		TraceFlags: trace.FlagsSampled,
	})
	ambient := baggage.ContextWithBaggage(trace.ContextWithSpanContext(t.Context(), parent), bag)
	for _, value := range []string{"", "invalid", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"} {
		ctx, cancel := context.WithCancel(ambient)
		extracted := ExtractTraceparent(ctx, value)
		cancel()
		if extracted.Err() != context.Canceled {
			t.Fatal("trace extraction lost request cancellation")
		}
		span := trace.SpanContextFromContext(extracted)
		if !span.IsValid() || span.TraceState().Len() != 0 || baggage.FromContext(extracted).Len() != 0 {
			t.Fatal("trace extraction must retain only correlation identifiers")
		}
		if value == "" || value == "invalid" {
			if span.TraceID() != parentTraceID || span.SpanID() != parentSpanID {
				t.Fatal("missing or invalid traceparent lost ambient correlation")
			}
		} else if !span.IsRemote() || span.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" {
			t.Fatal("valid traceparent did not preserve remote correlation")
		}
	}
}
