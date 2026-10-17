package webhookgateway

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestGatewayTelemetryTraceSurvivesQueueWithoutBaggage(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter), sdktrace.WithSampler(sdktrace.AlwaysSample()))
	old := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(old)
		_ = provider.Shutdown(context.Background())
	})
	ctx, root := provider.Tracer(gatewayInstrumentation).Start(context.Background(), "upstream")
	defer root.End()
	member, err := baggage.NewMember("private", "never-persist-baggage")
	if err != nil {
		t.Fatal(err)
	}
	privateBaggage, err := baggage.New(member)
	if err != nil {
		t.Fatal(err)
	}
	ctx = baggage.ContextWithBaggage(ctx, privateBaggage)
	_, snapshot := shellFixture()
	queue := &shellQueue{}
	handler := Ingress{SourceID: "projects", Secrets: shellSecrets{}, Policies: shellPolicy{snapshot: snapshot}, Queue: queue, Authorizer: &shellAuthorizer{}}
	request := shellRequest(`{"action":"edited","installation":{"id":10},"organization":{"id":20},"projects_v2_item":{"id":9}}`).WithContext(ctx)
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if len(queue.admission.Jobs) != 1 {
		t.Fatal("ingress failed to admit trace fixture")
	}
	admitted := queue.admission.Jobs[0]
	if len(admitted.TraceParent) != 55 {
		t.Fatalf("invalid persistent traceparent %q", admitted.TraceParent)
	}
	document, err := json.Marshal(admitted)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(document), "never-persist-baggage") || strings.Contains(string(document), "tracestate") {
		t.Fatal("private propagation state entered durable job")
	}
	worker := shellWorker(queue, &shellAuthorizer{})
	queue.job = &admitted
	queue.job.State, queue.job.ClaimID, queue.job.Fence, queue.job.Version = Claimed, "worker", 1, 2
	worker.Dispatcher = shellDispatch(func(dispatchCtx context.Context, _ Subscription, _ json.RawMessage) DispatchResponse {
		if baggage.FromContext(dispatchCtx).Len() != 0 || trace.SpanContextFromContext(dispatchCtx).TraceState().Len() != 0 {
			t.Error("worker restored private propagation state")
		}
		return DispatchResponse{StatusCode: 204, TransportOutcome: "response"}
	})
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored := propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{"traceparent": admitted.TraceParent})
	expected := trace.SpanContextFromContext(stored)
	for _, span := range exporter.GetSpans() {
		if span.Name == "cao_webhookgateway.attempt" {
			if span.SpanContext.TraceID() != expected.TraceID() || span.Parent.SpanID() != expected.SpanID() {
				t.Fatal("queue handoff broke trace correlation")
			}
			return
		}
	}
	t.Fatal("worker attempt span was not exported")
}
