package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/githubnext/gh-cao/server/internal/admission"
	"github.com/githubnext/gh-cao/server/internal/operational/memory"
)

func TestActivationAdmissionFullHandlerBoundary(t *testing.T) {
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	provider := sdktrace.NewTracerProvider()
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	}()
	verifier, err := admission.NewVerifier("https://admission.example/api/admission")
	if err != nil {
		t.Fatal(err)
	}
	app := &App{
		services: store.OperationalServices(),
		config: Config{HostProfile: hostedHostProfile(), Proxy: ProxyPolicy{
			AllowedHosts: []string{"admission.example"}, RequireHTTPS: true,
		}},
		admission: &admission.Service{Verifier: verifier},
	}
	handler := app.Handler()
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "OPTIONS"} {
		r := httptest.NewRequestWithContext(t.Context(), method, "https://admission.example/api/admission", strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer ghs_not_oidc")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		r.Header.Set("Baggage", "secret=not-for-export")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 403 || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s bypassed uniform denial: %d %s", method, w.Code, w.Body)
		}
		for name := range w.Header() {
			lower := strings.ToLower(name)
			if strings.Contains(lower, "trace") || strings.Contains(lower, "span") ||
				strings.Contains(lower, "ratelimit") || lower == "retry-after" || lower == "location" {
				t.Fatalf("header leaked: %s", name)
			}
		}
	}
	for n := 0; n < 61; n++ {
		r := httptest.NewRequestWithContext(t.Context(), "POST", "https://admission.example/api/admission", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if n == 60 && (w.Code != 429 || w.Body.Len() != 0 || w.Header().Get("Retry-After") != "") {
			t.Fatalf("probe limit leaked: %d %v", w.Code, w.Header())
		}
	}
	app.Drain()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), "POST", "https://admission.example/api/admission", nil))
	if w.Code != 503 || w.Body.Len() != 0 {
		t.Fatalf("draining: %d %s", w.Code, w.Body)
	}
	app.admission = nil
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), "POST", "https://admission.example/api/admission", nil))
	if w.Code != 403 || w.Body.Len() != 0 {
		t.Fatalf("disabled service fell through authentication: %d %s", w.Code, w.Body)
	}
}

func TestAdmissionTimeoutResponseAndConfiguration(t *testing.T) {
	success := httptest.NewRecorder()
	approved := &admissionResponse{ResponseWriter: success, headers: make(http.Header)}
	approved.Header().Set("X-Trace-Id", "must-not-escape")
	approved.WriteHeader(http.StatusOK)
	if _, err := approved.Write([]byte(`{"max_ai_credits":1}`)); err != nil {
		t.Fatal(err)
	}
	if success.Body.String() != `{"max_ai_credits":1}` || success.Header().Get("Content-Type") != "application/json" ||
		success.Header().Get("X-Trace-Id") != "" {
		t.Fatalf("success wire changed: %s %v", success.Body, success.Header())
	}
	w := httptest.NewRecorder()
	response := &admissionResponse{ResponseWriter: w, headers: make(http.Header)}
	http.TimeoutHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("X-Trace-Id", "must-not-escape")
		_, _ = w.Write([]byte(`{"max_ai_credits":1}`))
	}), time.Millisecond, "").ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), "POST", "/api/admission", nil))
	if w.Code != 503 || w.Body.Len() != 0 || w.Header().Get("X-Trace-Id") != "" {
		t.Fatalf("timeout: %d %s %v", w.Code, w.Body, w.Header())
	}
	for _, test := range []struct {
		file, audience string
		valid          bool
	}{
		{"", "", true}, {"snapshot.json", "", false}, {"", "audience", false}, {"snapshot.json", "audience", true},
	} {
		t.Setenv("CAO_ADMISSION_POLICY_FILE", test.file)
		t.Setenv("CAO_ADMISSION_AUDIENCE", test.audience)
		if _, err := admissionConfigFromEnv(); (err == nil) != test.valid {
			t.Fatalf("partial config accepted: %v", err)
		}
	}
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if _, err := newActivationAdmission(store, Config{Admission: &AdmissionConfig{Audience: "audience", PolicyFile: "snapshot.json"}}); err == nil {
		t.Fatal("volatile/local gate enabled")
	}
}
