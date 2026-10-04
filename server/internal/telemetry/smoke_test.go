package telemetry

import (
	"encoding/json"
	"errors"
	"io"
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

func TestRunSmokeVerifiesConfiguredGoRuntimeMetrics(t *testing.T) {
	const (
		traceID                   = "4bf92f3577b34da6a3ce929d0e0e4736"
		spanID                    = "00f067aa0ba902b7"
		traceAuthorizationHeader  = "Basic trace-credential"
		metricAuthorizationHeader = "Basic metric-credential"
	)
	cao := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set(TraceIDHeader, traceID)
		response.Header().Set(SpanIDHeader, spanID)
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(cao.Close)

	metricQueries := make(map[string]int)
	openObserve := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/healthz":
			response.WriteHeader(http.StatusOK)
		case "/api/default/default/traces/latest":
			if got := request.Header.Get("Authorization"); got != traceAuthorizationHeader {
				t.Errorf("trace authorization header = %q, want %q", got, traceAuthorizationHeader)
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"hits":[{"trace_id":"` + traceID + `"}]}`))
		case "/api/default/_search":
			if request.Method != http.MethodPost {
				t.Errorf("metric search method = %q, want POST", request.Method)
			}
			if got := request.Header.Get("Authorization"); got != metricAuthorizationHeader {
				t.Errorf("metric authorization header = %q, want %q", got, metricAuthorizationHeader)
			}
			if got := request.URL.Query().Get("type"); got != "metrics" {
				t.Errorf("metric search type = %q, want metrics", got)
			}
			var payload struct {
				Query struct {
					SQL       string `json:"sql"`
					StartTime int64  `json:"start_time"`
					EndTime   int64  `json:"end_time"`
					From      int    `json:"from"`
					Size      int    `json:"size"`
				} `json:"query"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode metric search request: %v", err)
			}
			if payload.Query.StartTime == 0 || payload.Query.EndTime <= payload.Query.StartTime ||
				payload.Query.From != 0 || payload.Query.Size != 1 {
				t.Errorf("metric search is not bounded: %+v", payload.Query)
			}
			switch {
			case strings.Contains(payload.Query.SQL, `"`+goMemoryAllocatedStream+`"`):
				metricQueries[goMemoryAllocatedStream]++
			case strings.Contains(payload.Query.SQL, `"`+goGoroutineCountStream+`"`):
				metricQueries[goGoroutineCountStream]++
			default:
				t.Errorf("unexpected metric SQL %q", payload.Query.SQL)
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"hits":[{"metric_rows":2}]}`))
		default:
			http.NotFound(response, request)
		}
	}))
	t.Cleanup(openObserve.Close)

	report, err := RunSmoke(t.Context(), SmokeConfig{
		CAOReadinessURL:    cao.URL + "/api/readiness",
		OTLPTraceEndpoint:  openObserve.URL + "/api/default/v1/traces",
		OTLPTraceHeaders:   "Authorization=Basic%20trace-credential",
		OTLPMetricEndpoint: openObserve.URL + "/api/default/v1/metrics",
		OTLPMetricHeaders:  "Authorization=Basic%20metric-credential",
		TraceStream:        "default",
		RequireMetrics:     true,
		Timeout:            time.Second,
		PollInterval:       time.Millisecond,
		Now:                func() time.Time { return time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("RunSmoke() error = %v", err)
	}
	if !report.MetricsRequired || !report.MetricsConfigured || !report.MetricsVerified || !report.Passed {
		t.Fatalf("metric smoke report = %+v, want required configured verified pass", report)
	}
	if report.GoMemoryAllocatedSearchStatus != http.StatusOK || !report.GoMemoryAllocatedFound {
		t.Errorf("go.memory.allocated search = (%d, %t), want (200, true)",
			report.GoMemoryAllocatedSearchStatus, report.GoMemoryAllocatedFound)
	}
	if report.GoGoroutineCountSearchStatus != http.StatusOK || !report.GoGoroutineCountFound {
		t.Errorf("go.goroutine.count search = (%d, %t), want (200, true)",
			report.GoGoroutineCountSearchStatus, report.GoGoroutineCountFound)
	}
	for _, stream := range []string{goMemoryAllocatedStream, goGoroutineCountStream} {
		if metricQueries[stream] != 1 {
			t.Errorf("metric query count for %q = %d, want 1", stream, metricQueries[stream])
		}
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		traceID,
		traceAuthorizationHeader,
		metricAuthorizationHeader,
		cao.URL,
		openObserve.URL,
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("metric smoke report contains sensitive runtime value %q", forbidden)
		}
	}
}

func TestRunSmokeFailsWhenRequiredMetricsAreNotConfigured(t *testing.T) {
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
		switch request.URL.Path {
		case "/healthz":
			response.WriteHeader(http.StatusOK)
		case "/api/default/default/traces/latest":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"hits":[{"trace_id":"` + traceID + `"}]}`))
		default:
			http.NotFound(response, request)
		}
	}))
	t.Cleanup(openObserve.Close)

	report, err := RunSmoke(t.Context(), SmokeConfig{
		CAOReadinessURL:   cao.URL + "/api/readiness",
		OTLPTraceEndpoint: openObserve.URL + "/api/default/v1/traces",
		OTLPTraceHeaders:  "Authorization=Basic%20trace-credential",
		TraceStream:       "default",
		RequireMetrics:    true,
		Timeout:           time.Second,
		PollInterval:      time.Millisecond,
	})
	if err != nil {
		t.Fatalf("RunSmoke() error = %v", err)
	}
	if !report.TraceFound || !report.MetricsRequired || report.MetricsConfigured ||
		report.MetricsVerified || report.Passed {
		t.Fatalf("required-but-unconfigured metric smoke report = %+v", report)
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
			name: "missing endpoint",
			config: SmokeConfig{
				CAOReadinessURL:  "http://127.0.0.1:8080/api/readiness",
				OTLPTraceHeaders: "Authorization=" + secret,
				TraceStream:      "default",
			},
		},
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
		{
			name: "metrics endpoint carries credentials",
			config: SmokeConfig{
				CAOReadinessURL:    "http://127.0.0.1:8080/api/readiness",
				OTLPTraceEndpoint:  "http://collector/api/default/v1/traces",
				OTLPTraceHeaders:   "Authorization=trace",
				OTLPMetricEndpoint: "http://user:" + secret + "@collector/api/default/v1/metrics",
				OTLPMetricHeaders:  "Authorization=metric",
				TraceStream:        "default",
			},
		},
		{
			name: "missing metrics authorization header",
			config: SmokeConfig{
				CAOReadinessURL:    "http://127.0.0.1:8080/api/readiness",
				OTLPTraceEndpoint:  "http://collector/api/default/v1/traces",
				OTLPTraceHeaders:   "Authorization=trace",
				OTLPMetricEndpoint: "http://collector/api/default/v1/metrics",
				OTLPMetricHeaders:  "X-Private=" + secret,
				TraceStream:        "default",
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

type smokeRoundTripper func(*http.Request) (*http.Response, error)

func (transport smokeRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

type smokeTestBody struct {
	reader    io.Reader
	readErr   error
	closeErr  error
	bytesRead int
	closes    int
}

func (body *smokeTestBody) Read(buffer []byte) (int, error) {
	if body.readErr != nil {
		return 0, body.readErr
	}
	n, err := body.reader.Read(buffer)
	body.bytesRead += n
	return n, err
}

func (body *smokeTestBody) Close() error {
	body.closes++
	return body.closeErr
}

func TestRunSmokeClosesBodiesAndReportsIOFailures(t *testing.T) {
	const (
		readinessPath = "/api/readiness"
		healthPath    = "/healthz"
		searchPath    = "/api/default/default/traces/latest"
		traceID       = "4bf92f3577b34da6a3ce929d0e0e4736"
		spanID        = "00f067aa0ba902b7"
	)
	bodyErr := errors.New("private body failure")
	tests := []struct {
		name          string
		failurePath   string
		readErr       error
		closeErr      error
		malformedJSON bool
		status        int
		readinessOK   bool
		healthOK      bool
		passed        bool
		searches      int
	}{
		{name: "success", readinessOK: true, healthOK: true, passed: true, searches: 1},
		{name: "readiness read error", failurePath: readinessPath, readErr: bodyErr, healthOK: true},
		{name: "readiness close error", failurePath: readinessPath, closeErr: bodyErr, healthOK: true},
		{name: "readiness status failure", failurePath: readinessPath, status: http.StatusServiceUnavailable, healthOK: true},
		{name: "health read error", failurePath: healthPath, readErr: bodyErr, readinessOK: true},
		{name: "health close error", failurePath: healthPath, closeErr: bodyErr, readinessOK: true},
		{name: "health status failure", failurePath: healthPath, status: http.StatusServiceUnavailable, readinessOK: true},
		{name: "search read error retries", failurePath: searchPath, readErr: bodyErr, readinessOK: true, healthOK: true, passed: true, searches: 2},
		{name: "search close error retries", failurePath: searchPath, closeErr: bodyErr, readinessOK: true, healthOK: true, passed: true, searches: 2},
		{name: "malformed search retries", failurePath: searchPath, malformedJSON: true, readinessOK: true, healthOK: true, passed: true, searches: 2},
		{name: "server failure retries", failurePath: searchPath, status: http.StatusServiceUnavailable, readinessOK: true, healthOK: true, passed: true, searches: 2},
		{name: "request timeout retries", failurePath: searchPath, status: http.StatusRequestTimeout, readinessOK: true, healthOK: true, passed: true, searches: 2},
		{name: "rate limit retries", failurePath: searchPath, status: http.StatusTooManyRequests, readinessOK: true, healthOK: true, passed: true, searches: 2},
		{name: "authorization failure", failurePath: searchPath, status: http.StatusUnauthorized, readinessOK: true, healthOK: true, searches: 1},
		{name: "authorization body read failure", failurePath: searchPath, status: http.StatusUnauthorized, readErr: bodyErr, readinessOK: true, healthOK: true, searches: 1},
		{name: "authorization body close failure", failurePath: searchPath, status: http.StatusUnauthorized, closeErr: bodyErr, readinessOK: true, healthOK: true, searches: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requests := make(map[string]int)
			var bodies []*smokeTestBody
			client := &http.Client{Transport: smokeRoundTripper(func(request *http.Request) (*http.Response, error) {
				for _, body := range bodies {
					if body.closes != 1 {
						t.Errorf("previous response body closed %d times before next request, want 1", body.closes)
					}
				}
				path := request.URL.Path
				requests[path]++
				payload := "ok"
				if path == searchPath {
					payload = `{"hits":[{"trace_id":"` + traceID + `"}]}`
				}
				status := http.StatusOK
				body := &smokeTestBody{}
				if path == tt.failurePath && requests[path] == 1 {
					body.readErr, body.closeErr = tt.readErr, tt.closeErr
					if tt.malformedJSON {
						payload = `{"hits":`
					}
					if tt.status != 0 {
						status = tt.status
					}
				}
				body.reader = strings.NewReader(payload)
				bodies = append(bodies, body)
				return &http.Response{
					StatusCode: status,
					Header: http.Header{
						TraceIDHeader: []string{traceID},
						SpanIDHeader:  []string{spanID},
					},
					Body: body,
				}, nil
			})}
			report, err := RunSmoke(t.Context(), SmokeConfig{
				CAOReadinessURL:   "http://cao/api/readiness",
				OTLPTraceEndpoint: "http://collector/api/default/v1/traces",
				OTLPTraceHeaders:  "Authorization=Basic test-credential",
				TraceStream:       "default",
				HTTPClient:        client,
				Timeout:           time.Second,
				PollInterval:      time.Millisecond,
			})
			if err != nil {
				t.Fatalf("RunSmoke() error = %v, want sanitized report without error", err)
			}
			if report.CAOReadinessOK != tt.readinessOK || report.OpenObserveHealthOK != tt.healthOK ||
				report.TraceFound != tt.passed || report.Passed != tt.passed {
				t.Errorf("RunSmoke() = %+v, want readiness=%t health=%t found=%t passed=%t",
					report, tt.readinessOK, tt.healthOK, tt.passed, tt.passed)
			}
			wantReadinessStatus, wantHealthStatus := http.StatusOK, http.StatusOK
			if tt.status != 0 {
				if tt.failurePath == readinessPath {
					wantReadinessStatus = tt.status
				}
				if tt.failurePath == healthPath {
					wantHealthStatus = tt.status
				}
			}
			if report.CAOReadinessStatus != wantReadinessStatus || report.OpenObserveHealthStatus != wantHealthStatus {
				t.Errorf("response statuses = (%d, %d), want (%d, %d)",
					report.CAOReadinessStatus, report.OpenObserveHealthStatus, wantReadinessStatus, wantHealthStatus)
			}
			if got := requests[searchPath]; got != tt.searches {
				t.Errorf("search requests = %d, want %d", got, tt.searches)
			}
			for _, body := range bodies {
				if body.closes != 1 {
					t.Errorf("response body closed %d times, want 1", body.closes)
				}
			}
		})
	}
}

func TestSmokeResponseReadersPropagateErrorsAndBoundReads(t *testing.T) {
	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	readErr := errors.New("private read failure")
	if err := discardSmokeBody(&smokeTestBody{readErr: readErr}); !errors.Is(err, readErr) {
		t.Errorf("discardSmokeBody() error = %v, want %v", err, readErr)
	}
	if found, err := smokeSearchContainsTrace(&smokeTestBody{readErr: readErr}, traceID); found || !errors.Is(err, readErr) {
		t.Errorf("smokeSearchContainsTrace() = (%t, %v), want (false, %v)", found, err, readErr)
	}
	if found, err := smokeMetricSearchHasRows(&smokeTestBody{readErr: readErr}); found || !errors.Is(err, readErr) {
		t.Errorf("smokeMetricSearchHasRows() = (%t, %v), want (false, %v)", found, err, readErr)
	}
	if found, err := smokeMetricSearchHasRows(strings.NewReader(`{"hits":[{"metric_rows":1}]}`)); err != nil || !found {
		t.Errorf("smokeMetricSearchHasRows() = (%t, %v), want (true, nil)", found, err)
	}
	oversized := strings.Repeat(" ", maxSmokeResponseBytes) + `{"trace_id":"` + traceID + `"}`
	body := &smokeTestBody{reader: strings.NewReader(oversized)}
	if found, err := smokeSearchContainsTrace(body, traceID); found || err == nil {
		t.Errorf("oversized smokeSearchContainsTrace() = (%t, %v), want (false, error)", found, err)
	}
	if body.bytesRead != maxSmokeResponseBytes {
		t.Errorf("search bytes read = %d, want %d", body.bytesRead, maxSmokeResponseBytes)
	}
	body = &smokeTestBody{reader: strings.NewReader(oversized)}
	if found, err := smokeMetricSearchHasRows(body); found || err == nil {
		t.Errorf("oversized smokeMetricSearchHasRows() = (%t, %v), want (false, error)", found, err)
	}
	if body.bytesRead != maxSmokeResponseBytes {
		t.Errorf("metric search bytes read = %d, want %d", body.bytesRead, maxSmokeResponseBytes)
	}
	body = &smokeTestBody{reader: strings.NewReader(oversized)}
	if err := discardSmokeBody(body); err != nil {
		t.Errorf("bounded discardSmokeBody() error = %v", err)
	}
	if body.bytesRead != maxSmokeResponseBytes {
		t.Errorf("discard bytes read = %d, want %d", body.bytesRead, maxSmokeResponseBytes)
	}
}
