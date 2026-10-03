package githubquota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestQuotaTelemetryOmitsRawErrorsAndInvalidBucketIdentity(t *testing.T) {
	traces, reader := installTestTelemetry(t)
	service, store := newTestService(t, Options{})
	for _, failure := range []error{
		errors.New("private-credential at private-host"),
		fmt.Errorf("private-key: %w", context.DeadlineExceeded),
		fmt.Errorf("private-query: %w", context.Canceled),
	} {
		store.usageErr = failure
		if _, err := service.Usage(t.Context()); !errors.Is(err, failure) {
			t.Fatal("telemetry must not replace the original operational error")
		}
	}
	for _, bucket := range []BucketID{
		{App: "private:app", Installation: 42},
		{App: "private-app", Installation: 0},
		{App: "collector", Installation: 42, Resource: "private:resource"},
	} {
		if _, err := service.Reserve(t.Context(), bucket, ReservationRequest{EstimatedCost: 1}); err == nil {
			t.Fatal("invalid bucket was accepted")
		}
	}
	spans := traces.GetSpans()
	wantErrors := []string{"_OTHER", "timeout", "canceled", "invalid_request", "invalid_request", "invalid_request"}
	if len(spans) != len(wantErrors) {
		t.Fatalf("spans = %d, want %d", len(spans), len(wantErrors))
	}
	for i, span := range spans {
		attrs := attribute.NewSet(span.Attributes...)
		errorType, _ := attrs.Value(attribute.Key("error.type"))
		if errorType.AsString() != wantErrors[i] || span.Status.Code != codes.Error || len(span.Events) != 0 {
			t.Fatalf("quota errors must use bounded classifications without exception events: %+v", span)
		}
		if i >= 3 {
			for _, key := range []string{attributeApp, attributeInstallation, attributeResource} {
				if _, present := attrs.Value(attribute.Key(key)); present {
					t.Fatalf("invalid bucket identity leaked through %s", key)
				}
			}
		}
	}
	var measured metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &measured); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(struct {
		Spans   tracetest.SpanStubs
		Metrics metricdata.ResourceMetrics
	}{spans, measured})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private") {
		t.Fatal("quota telemetry exposed an error message or invalid bucket identity")
	}
}
