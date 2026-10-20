package admission

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/githubnext/gh-cao/server/internal/telemetry"
)

type unavailableExporter struct{}

func (unavailableExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return errors.New("synthetic exporter unavailable")
}
func (unavailableExporter) Shutdown(context.Context) error { return nil }

func TestAdmissionExporterFailureDoesNotChangeOperation(t *testing.T) {
	previous, previousHandler := otel.GetTracerProvider(), otel.GetErrorHandler()
	var failures atomic.Int64
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) { failures.Add(1) }))
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(unavailableExporter{}))
	otel.SetTracerProvider(provider)
	defer func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
		otel.SetErrorHandler(previousHandler)
	}()
	value, err := observeOperation(t.Context(), telemetry.SpanAdmissionDecision, func(context.Context) (Allowances, error) {
		return Allowances{Primary: 1000}, nil
	})
	if err != nil || value.Primary != 1000 || failures.Load() != 1 {
		t.Fatalf("export failure changed operation: %+v %v failures=%d", value, err, failures.Load())
	}
}

func TestAdmissionOperationSpansRedactDependencies(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	}()
	for _, failure := range []error{nil, ErrDenied, errors.New("PRIVATE raw storage credential")} {
		exporter.Reset()
		value, err := observeOperation(t.Context(), telemetry.SpanAdmissionDecision, func(ctx context.Context) (int, error) {
			if !trace.SpanContextFromContext(ctx).IsValid() {
				t.Fatal("operation context missing span")
			}
			return 42, failure
		})
		if value != 42 || !errors.Is(err, failure) {
			t.Fatal("telemetry changed operation result")
		}
		spans := exporter.GetSpans()
		if len(spans) != 1 || spans[0].Name != telemetry.SpanAdmissionDecision || len(spans[0].Events) != 0 || len(spans[0].Attributes) != 0 {
			t.Fatalf("unexpected stage telemetry: %+v", spans)
		}
		if failure != nil && !errors.Is(failure, ErrDenied) {
			if spans[0].Status.Code != codes.Error || spans[0].Status.Description != "admission dependency unavailable" {
				t.Fatal("missing generic dependency error")
			}
		} else if spans[0].Status.Code != codes.Unset {
			t.Fatal("policy denial became telemetry error")
		}
		encoded, err := json.Marshal(spans)
		if err != nil || strings.Contains(string(encoded), "PRIVATE") {
			t.Fatal("raw failure leaked")
		}
	}
}

func TestAdmissionOTLPExportAndShutdownFlush(t *testing.T) {
	var mu sync.Mutex
	var exported []*tracecollector.ExportTraceServiceRequest
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/traces" || r.Header.Get("Content-Type") != "application/x-protobuf" {
			t.Error("unexpected OTLP transport")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		message := new(tracecollector.ExportTraceServiceRequest)
		if err := proto.Unmarshal(body, message); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		exported = append(exported, message)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer receiver.Close()
	previous, previousPropagation := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	defer func() { otel.SetTracerProvider(previous); otel.SetTextMapPropagator(previousPropagation) }()
	for _, key := range []string{"OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_RESOURCE_ATTRIBUTES"} {
		t.Setenv(key, "")
	}
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", receiver.URL+"/v1/traces")
	t.Setenv("OTEL_SERVICE_NAME", "cao-admission-test")
	t.Setenv("CAO_OTEL_LOGS_ENABLED", "false")
	shutdown, err := telemetry.Setup(t.Context(), "test-version")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = shutdown(context.Background()) }()
	fixture := newFixture(t)
	body, err := json.Marshal(fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	ctx := propagation.TraceContext{}.Extract(t.Context(), propagation.MapCarrier{
		"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
	})
	ctx, parent := telemetry.Tracer().Start(ctx, "POST /api/admission", trace.WithSpanKind(trace.SpanKindServer))
	service := &Service{Verifier: fixture.verifier,
		Policies:  policyFunc(func(context.Context, Identity) (Allowances, error) { return Allowances{Primary: 1000}, nil }),
		Decisions: decisionsFunc(func(_ context.Context, _ string, a *Allowances) (Allowances, error) { return *a, nil }),
		Runs:      admittedRunFunc(func(context.Context, Identity) error { return nil }),
	}
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "https://admission.example/api/admission", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	token := fixture.token(t, fixture.claims)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	service.ServeHTTP(response, request)
	parent.End()
	if response.Code != http.StatusOK {
		t.Fatalf("export config changed admission: %d", response.Code)
	}
	flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := shutdown(flushCtx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	names := map[string]bool{}
	traceID := parent.SpanContext().TraceID()
	resourceFound := false
	for _, batch := range exported {
		for _, resource := range batch.ResourceSpans {
			for _, attr := range resource.Resource.Attributes {
				if attr.Key == "service.name" && attr.Value.GetStringValue() == "cao-admission-test" {
					resourceFound = true
				}
			}
			for _, scope := range resource.ScopeSpans {
				for _, span := range scope.Spans {
					names[span.Name] = true
					if string(span.TraceId) != string(traceID[:]) {
						t.Fatal("OTLP export lost caller trace")
					}
				}
			}
		}
		encoded := batch.String()
		for _, sensitive := range []string{token, fixture.request.Repo, fixture.request.Actor, fixture.request.WorkflowHash, "max_ai_credits"} {
			if strings.Contains(encoded, sensitive) {
				t.Fatalf("OTLP exported private request/policy data: %s", sensitive)
			}
		}
	}
	for _, name := range []string{"POST /api/admission", telemetry.SpanAdmissionIdentity, telemetry.SpanAdmissionKeys, telemetry.SpanAdmissionPolicy, telemetry.SpanAdmissionDecision, telemetry.SpanAdmissionRun} {
		if !names[name] {
			t.Fatalf("shutdown did not flush span %s", name)
		}
	}
	if !resourceFound {
		t.Fatal("service resource missing from OTLP")
	}
}
