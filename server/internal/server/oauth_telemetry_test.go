package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestOAuthCallbackTelemetryExcludesCredentialsAndIdentifiers(t *testing.T) {
	previousTracer := otel.GetTracerProvider()
	previousMeter := otel.GetMeterProvider()
	previousPropagator := otel.GetTextMapPropagator()
	traces := tracetest.NewInMemoryExporter()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(traces))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = meterProvider.Shutdown(t.Context())
		_ = traceProvider.Shutdown(t.Context())
		otel.SetTracerProvider(previousTracer)
		otel.SetMeterProvider(previousMeter)
		otel.SetTextMapPropagator(previousPropagator)
	})

	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	stateCookie, state := loginState(t, app)
	firstState, firstCookieValue := state, stateCookie.Value
	traces.Reset()

	secretCode := "private-oauth-code"
	request := azureRequest(t, http.MethodGet, "/auth/callback?code="+secretCode+"&state="+url.QueryEscape(state))
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	request.Header.Set("User-Agent", "private-user-agent")
	request.Header.Set("X-Forwarded-For", "192.0.2.89")
	request.AddCookie(stateCookie)
	success := httptest.NewRecorder()
	app.Handler().ServeHTTP(success, request)
	if success.Code != http.StatusFound {
		t.Fatalf("success status = %d", success.Code)
	}
	if success.Header().Get("X-Trace-Id") != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		success.Header().Get("X-Span-Id") == "" {
		t.Fatal("callback must return its W3C trace and span identifiers")
	}

	invalid := httptest.NewRecorder()
	app.Handler().ServeHTTP(invalid, azureRequest(t, http.MethodGet, "/auth/callback?code="+secretCode+"&state=private-invalid-state"))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid state status = %d", invalid.Code)
	}

	stateCookie, state = loginState(t, app)
	missing := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/auth/callback?state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(missing, request)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing code status = %d", missing.Code)
	}

	stateCookie, state = loginState(t, app)
	denied := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/auth/callback?error=private-provider-message&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(denied, request)
	if denied.Code != http.StatusBadRequest {
		t.Fatalf("provider denial status = %d", denied.Code)
	}

	stateCookie, state = loginState(t, app)
	app.oauth.config.TokenURL = github.URL + "/unavailable"
	exchange := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/auth/callback?code="+secretCode+"&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(exchange, request)
	if exchange.Code != http.StatusUnauthorized {
		t.Fatalf("exchange failure status = %d", exchange.Code)
	}

	deniedGitHub := fakeGitHub(t, fakeGitHubOptions{membershipState: "pending", accessExpiresIn: 3600})
	app = newAzureTestApp(t, deniedGitHub.URL)
	stateCookie, state = loginState(t, app)
	unauthorized := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/auth/callback?code="+secretCode+"&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(unauthorized, request)
	if unauthorized.Code != http.StatusForbidden {
		t.Fatalf("authorization failure status = %d", unauthorized.Code)
	}

	app = newAzureTestApp(t, github.URL)
	stateCookie, state = loginState(t, app)
	unavailable, err := redisx.New("redis://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	app.oauth.store = redisx.NewStore(unavailable, "test")
	failedSave := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/auth/callback?code="+secretCode+"&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(failedSave, request)
	if failedSave.Code != http.StatusServiceUnavailable {
		t.Fatalf("session save failure status = %d", failedSave.Code)
	}

	var spans tracetest.SpanStubs
	for _, span := range traces.GetSpans() {
		if span.Name == "GET /auth/callback" {
			spans = append(spans, span)
		}
	}
	if len(spans) != 7 {
		t.Fatalf("callback produced %d spans, want exactly one per callback", len(spans))
	}
	for _, span := range spans {
		if span.Name != "GET /auth/callback" || span.SpanKind != trace.SpanKindServer {
			t.Fatalf("unexpected callback span: %s (%v)", span.Name, span.SpanKind)
		}
		if len(span.Events) != 0 {
			t.Fatal("callback span must not record raw exceptions")
		}
	}
	if spans[6].Status.Code != codes.Error {
		t.Fatal("session persistence failure must mark the callback span as a server error")
	}
	if spans[0].Parent.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		!spans[0].Parent.IsRemote() {
		t.Fatal("callback did not preserve the remote W3C parent")
	}
	for i, expected := range []struct{ outcome, errorType string }{
		{"success", ""}, {"failure", "invalid_state"}, {"failure", "missing_code"},
		{"failure", "provider_denied"}, {"failure", "exchange_failed"}, {"failure", "authorization_failed"},
		{"failure", "session_save_failed"},
	} {
		if i < 6 && spans[i].Status.Code != codes.Unset {
			t.Fatalf("client outcome %d must not be marked as a server error", i)
		}
		attrs := spanAttributes(spans[i].Attributes)
		if attrs["http.route"] != "/auth/callback" || attrs["http.request.method"] != "GET" ||
			attrs["cao_dashboard.auth.callback.outcome"] != expected.outcome {
			t.Fatalf("unexpected callback attributes: %#v", attrs)
		}
		if expected.errorType == "" {
			if _, ok := attrs["error.type"]; ok {
				t.Fatal("successful callback has an error.type")
			}
		} else if attrs["error.type"] != expected.errorType {
			t.Fatalf("error type = %#v, want %s", attrs["error.type"], expected.errorType)
		}
	}

	var data metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &data); err != nil {
		t.Fatal(err)
	}
	var outcomes []string
	for _, scope := range data.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name != "cao_dashboard.auth.callback.count" {
				continue
			}
			for _, point := range instrument.Data.(metricdata.Sum[int64]).DataPoints {
				attrs := spanAttributes(point.Attributes.ToSlice())
				if point.Value != 1 {
					t.Fatalf("callback count = %d, want 1", point.Value)
				}
				outcome := attrs["cao_dashboard.auth.callback.outcome"].(string) + "/"
				if errorType, ok := attrs["error.type"].(string); ok {
					outcome += errorType
				}
				outcomes = append(outcomes, outcome)
			}
		}
	}
	for _, expected := range []string{"success/", "failure/invalid_state", "failure/missing_code",
		"failure/provider_denied", "failure/exchange_failed", "failure/authorization_failed",
		"failure/session_save_failed"} {
		found := false
		for _, outcome := range outcomes {
			found = found || outcome == expected
		}
		if !found {
			t.Fatalf("missing metric outcome %q in %v", expected, outcomes)
		}
	}
	if len(outcomes) != 7 {
		t.Fatalf("unexpected metric outcomes: %v", outcomes)
	}

	encoded, err := json.Marshal(struct {
		Spans   tracetest.SpanStubs
		Metrics metricdata.ResourceMetrics
	}{spans, data})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{secretCode, firstState, firstCookieValue, state, stateCookie.Value,
		"private-invalid-state", "private-provider-message",
		"private-user-agent", "192.0.2.89", "access-old", "refresh-old", "test-user"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("OAuth telemetry exposed private value %q", private)
		}
	}
}
