package telemetry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunSmokeFindsExportedTraceWithoutReportingSecrets(t *testing.T) {
	const (
		traceID             = "4bf92f3577b34da6a3ce929d0e0e4736"
		spanID              = "00f067aa0ba902b7"
		authorizationHeader = "Basic test-credential"
	)
	cao := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set(TraceIDHeader, traceID)
		response.Header().Set(SpanIDHeader, spanID)
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(cao.Close)

	var searchRequests atomic.Int64
	openObserve := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/healthz":
			response.WriteHeader(http.StatusOK)
		case "/api/default/default/traces/latest":
			searchRequests.Add(1)
			if got := request.Header.Get("Authorization"); got != authorizationHeader {
				t.Errorf("authorization header = %q, want %q", got, authorizationHeader)
			}
			if got := request.URL.Query().Get("filter"); got != "trace_id='"+traceID+"'" {
				t.Errorf("filter = %q, want %q", got, "trace_id='"+traceID+"'")
			}
			for _, name := range []string{"start_time", "end_time", "from", "size"} {
				if request.URL.Query().Get(name) == "" {
					t.Errorf("query parameter %q is missing", name)
				}
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"total":1,"hits":[{"trace_id":"` + traceID + `"}]}`))
		default:
			http.NotFound(response, request)
		}
	}))
	t.Cleanup(openObserve.Close)

	report, err := RunSmoke(t.Context(), SmokeConfig{
		CAOReadinessURL:   cao.URL + "/api/readiness",
		OTLPTraceEndpoint: openObserve.URL + "/api/default/v1/traces",
		OTLPTraceHeaders:  "Authorization=Basic%20test-credential",
		TraceStream:       "default",
		Timeout:           time.Second,
		PollInterval:      time.Millisecond,
		Now:               func() time.Time { return time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("RunSmoke() error = %v", err)
	}
	if report.CAOReadinessStatus != http.StatusOK || !report.CAOReadinessOK {
		t.Errorf("CAO readiness = (%d, %t), want (200, true)", report.CAOReadinessStatus, report.CAOReadinessOK)
	}
	if !report.TraceHeadersPresent {
		t.Error("trace headers must be present")
	}
	if report.OpenObserveHealthStatus != http.StatusOK || !report.OpenObserveHealthOK {
		t.Errorf("OpenObserve health = (%d, %t), want (200, true)", report.OpenObserveHealthStatus, report.OpenObserveHealthOK)
	}
	if report.OpenObserveSearchStatus != http.StatusOK || !report.TraceFound || !report.Passed {
		t.Errorf("OpenObserve search = (%d, found=%t, passed=%t), want (200, true, true)",
			report.OpenObserveSearchStatus, report.TraceFound, report.Passed)
	}
	if searchRequests.Load() != 1 {
		t.Errorf("search requests = %d, want 1", searchRequests.Load())
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{traceID, authorizationHeader, cao.URL, openObserve.URL} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("smoke report contains sensitive runtime value %q", forbidden)
		}
	}
}

func TestRunSmokeReportsAuthorizationFailure(t *testing.T) {
	const (
		traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
		spanID  = "00f067aa0ba902b7"
	)
	cao := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set(TraceIDHeader, traceID)
		response.Header().Set(SpanIDHeader, spanID)
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(cao.Close)
	openObserve := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/healthz" {
			response.WriteHeader(http.StatusOK)
			return
		}
		response.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(openObserve.Close)

	report, err := RunSmoke(t.Context(), SmokeConfig{
		CAOReadinessURL:   cao.URL + "/api/readiness",
		OTLPTraceEndpoint: openObserve.URL + "/api/default/v1/traces",
		OTLPTraceHeaders:  "Authorization=Basic test-credential",
		TraceStream:       "default",
		Timeout:           time.Second,
		PollInterval:      time.Millisecond,
	})
	if err != nil {
		t.Fatalf("RunSmoke() error = %v", err)
	}
	if report.OpenObserveSearchStatus != http.StatusUnauthorized {
		t.Errorf("search status = %d, want %d", report.OpenObserveSearchStatus, http.StatusUnauthorized)
	}
	if report.TraceFound || report.Passed {
		t.Errorf("authorization failure reported found=%t passed=%t, want false false", report.TraceFound, report.Passed)
	}
}

func TestRunSmokeRejectsInvalidConfigurationWithoutEchoingValues(t *testing.T) {
	const secret = "private-test-value"
	tests := []struct {
		name   string
		config SmokeConfig
	}{
		{
			name: "SDK disabled",
			config: SmokeConfig{
				CAOReadinessURL:   "http://127.0.0.1:8080/api/readiness",
				OTELSDKDisabled:   "true",
				OTLPTraceEndpoint: "http://collector/api/default/v1/traces",
				OTLPTraceHeaders:  "Authorization=" + secret,
				TraceStream:       "default",
			},
		},
		{
			name: "missing authorization header",
			config: SmokeConfig{
				CAOReadinessURL:   "http://127.0.0.1:8080/api/readiness",
				OTLPTraceEndpoint: "http://collector/api/default/v1/traces",
				OTLPTraceHeaders:  "X-Private=" + secret,
				TraceStream:       "default",
			},
		},
		{
			name: "endpoint carries credentials",
			config: SmokeConfig{
				CAOReadinessURL:   "http://127.0.0.1:8080/api/readiness",
				OTLPTraceEndpoint: "http://user:" + secret + "@collector/api/default/v1/traces",
				OTLPTraceHeaders:  "Authorization=" + secret,
				TraceStream:       "default",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := RunSmoke(t.Context(), tt.config)
			if err == nil {
				t.Fatal("RunSmoke() error = nil, want non-nil")
			}
			if strings.Contains(err.Error(), secret) {
				t.Errorf("RunSmoke() error leaked a sensitive value: %q", err)
			}
		})
	}
}
