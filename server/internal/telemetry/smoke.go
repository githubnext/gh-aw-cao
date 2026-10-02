package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/trace"
)

const (
	// SmokeReportSchemaVersion versions the deployment smoke report.
	SmokeReportSchemaVersion = 1
	defaultSmokeTimeout      = 30 * time.Second
	defaultSmokePollInterval = time.Second
	defaultSmokeLookback     = 5 * time.Minute
	maxSmokeResponseBytes    = 1 << 20
)

// SmokeConfig configures an end-to-end trace export and OpenObserve lookup.
// Endpoint and header values are consumed only for requests and never copied
// into the report.
type SmokeConfig struct {
	CAOReadinessURL   string
	OTELSDKDisabled   string
	OTLPEndpoint      string
	OTLPHeaders       string
	OTLPTraceEndpoint string
	OTLPTraceHeaders  string
	TraceStream       string
	Timeout           time.Duration
	PollInterval      time.Duration
	Lookback          time.Duration
	HTTPClient        *http.Client
	Now               func() time.Time
}

// SmokeReport contains only status codes and booleans so it is safe to retain
// in deployment logs.
type SmokeReport struct {
	SchemaVersion           int  `json:"schemaVersion"`
	CAOReadinessStatus      int  `json:"caoReadinessStatus"`
	CAOReadinessOK          bool `json:"caoReadinessOK"`
	TraceHeadersPresent     bool `json:"traceHeadersPresent"`
	OpenObserveHealthStatus int  `json:"openObserveHealthStatus"`
	OpenObserveHealthOK     bool `json:"openObserveHealthOK"`
	OpenObserveSearchStatus int  `json:"openObserveSearchStatus"`
	TraceFound              bool `json:"traceFound"`
	Passed                  bool `json:"passed"`
}

type openObserveTarget struct {
	baseURL       url.URL
	organization  string
	authorization string
}

type openObserveTraceSearch struct {
	TraceID string `json:"trace_id"`
	Hits    []struct {
		TraceID string `json:"trace_id"`
	} `json:"hits"`
}

// RunSmoke requests CAO readiness, confirms OpenObserve health, and polls for
// the resulting trace. Operational failures are represented in the report;
// errors are reserved for invalid configuration.
func RunSmoke(ctx context.Context, config SmokeConfig) (SmokeReport, error) {
	report := SmokeReport{SchemaVersion: SmokeReportSchemaVersion}
	readinessURL, err := parseSmokeReadinessURL(config.CAOReadinessURL)
	if err != nil {
		return report, err
	}
	target, err := resolveOpenObserveTarget(config)
	if err != nil {
		return report, err
	}
	stream := strings.TrimSpace(config.TraceStream)
	if !validOpenObserveSegment(stream) {
		return report, errors.New("OpenObserve trace stream must be a non-empty path segment")
	}

	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultSmokeTimeout
	}
	pollInterval := config.PollInterval
	if pollInterval <= 0 {
		pollInterval = defaultSmokePollInterval
	}
	lookback := config.Lookback
	if lookback <= 0 {
		lookback = defaultSmokeLookback
	}
	client := config.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}

	smokeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	windowStart := now().UTC().Add(-lookback)

	readinessRequest, err := http.NewRequestWithContext(smokeCtx, http.MethodGet, readinessURL.String(), nil)
	if err != nil {
		return report, errors.New("build CAO readiness request")
	}
	readinessResponse, requestErr := client.Do(readinessRequest)
	var traceID trace.TraceID
	if requestErr == nil {
		report.CAOReadinessStatus = readinessResponse.StatusCode
		traceID, report.TraceHeadersPresent = validResponseTraceHeaders(readinessResponse.Header)
		readErr := discardSmokeBody(readinessResponse.Body)
		closeErr := readinessResponse.Body.Close()
		report.CAOReadinessOK = readinessResponse.StatusCode == http.StatusOK && readErr == nil && closeErr == nil
	}

	healthURL := target.baseURL
	healthURL.Path = "/healthz"
	healthRequest, err := http.NewRequestWithContext(smokeCtx, http.MethodGet, healthURL.String(), nil)
	if err != nil {
		return report, errors.New("build OpenObserve health request")
	}
	healthResponse, requestErr := client.Do(healthRequest)
	if requestErr == nil {
		report.OpenObserveHealthStatus = healthResponse.StatusCode
		readErr := discardSmokeBody(healthResponse.Body)
		closeErr := healthResponse.Body.Close()
		report.OpenObserveHealthOK = healthResponse.StatusCode == http.StatusOK && readErr == nil && closeErr == nil
	}

	if !report.CAOReadinessOK || !report.TraceHeadersPresent || !report.OpenObserveHealthOK {
		return report, nil
	}

	for {
		searchURL := target.baseURL
		searchURL.Path = "/api/" + target.organization + "/" + stream + "/traces/latest"
		query := searchURL.Query()
		query.Set("filter", "trace_id='"+traceID.String()+"'")
		query.Set("start_time", strconv.FormatInt(windowStart.UnixMicro(), 10))
		query.Set("end_time", strconv.FormatInt(now().UTC().Add(time.Minute).UnixMicro(), 10))
		query.Set("from", "0")
		query.Set("size", "1")
		searchURL.RawQuery = query.Encode()

		searchRequest, requestBuildErr := http.NewRequestWithContext(smokeCtx, http.MethodGet, searchURL.String(), nil)
		if requestBuildErr != nil {
			return report, errors.New("build OpenObserve trace search request")
		}
		searchRequest.Header.Set("Authorization", target.authorization)
		searchResponse, searchErr := client.Do(searchRequest)
		if searchErr == nil {
			report.OpenObserveSearchStatus = searchResponse.StatusCode
			var readErr error
			if searchResponse.StatusCode == http.StatusOK {
				report.TraceFound, readErr = smokeSearchContainsTrace(searchResponse.Body, traceID.String())
			} else {
				readErr = discardSmokeBody(searchResponse.Body)
			}
			closeErr := searchResponse.Body.Close()
			if readErr != nil || closeErr != nil {
				report.TraceFound = false
			}
			if report.TraceFound {
				report.Passed = true
				return report, nil
			}
			if searchResponse.StatusCode >= http.StatusBadRequest &&
				searchResponse.StatusCode < http.StatusInternalServerError &&
				searchResponse.StatusCode != http.StatusRequestTimeout &&
				searchResponse.StatusCode != http.StatusTooManyRequests {
				return report, nil
			}
		}

		timer := time.NewTimer(pollInterval)
		select {
		case <-smokeCtx.Done():
			timer.Stop()
			return report, nil
		case <-timer.C:
		}
	}
}

func resolveOpenObserveTarget(config SmokeConfig) (openObserveTarget, error) {
	endpoint, decision := resolveExporterDecision(
		config.OTELSDKDisabled,
		config.OTLPTraceEndpoint,
		config.OTLPEndpoint,
	)
	switch decision {
	case exporterDecisionDisabled:
		return openObserveTarget{}, errors.New("OpenTelemetry SDK is disabled")
	case exporterDecisionNoEndpoint:
		return openObserveTarget{}, errors.New("OTLP traces endpoint is not configured")
	case exporterDecisionConfigured:
	}
	if strings.TrimSpace(config.OTLPTraceEndpoint) == "" {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return openObserveTarget{}, errors.New("OTLP endpoint is not a valid URL")
		}
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/traces"
		endpoint = parsed.String()
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return openObserveTarget{}, errors.New("OTLP traces endpoint must be an absolute HTTP(S) URL without credentials, query, or fragment")
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(segments) != 4 || segments[0] != "api" || segments[2] != "v1" || segments[3] != "traces" ||
		!validOpenObserveSegment(segments[1]) {
		return openObserveTarget{}, errors.New("OTLP traces endpoint must end with /api/{organization}/v1/traces")
	}
	authorization, err := extractAuthorizationHeader(firstNonEmpty(config.OTLPTraceHeaders, config.OTLPHeaders))
	if err != nil {
		return openObserveTarget{}, err
	}
	return openObserveTarget{
		baseURL:       url.URL{Scheme: parsed.Scheme, Host: parsed.Host},
		organization:  segments[1],
		authorization: authorization,
	}, nil
}

func extractAuthorizationHeader(raw string) (string, error) {
	for _, item := range strings.Split(raw, ",") {
		name, value, found := strings.Cut(strings.TrimSpace(item), "=")
		if !found {
			continue
		}
		decodedName, nameErr := url.PathUnescape(strings.TrimSpace(name))
		decodedValue, valueErr := url.PathUnescape(strings.TrimSpace(value))
		if nameErr != nil || valueErr != nil {
			return "", errors.New("OTLP headers contain invalid percent encoding")
		}
		if strings.EqualFold(decodedName, "Authorization") && decodedValue != "" {
			return decodedValue, nil
		}
	}
	return "", errors.New("OTLP Authorization header is not configured in key=value format")
}

func parseSmokeReadinessURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		strings.TrimRight(parsed.Path, "/") != "/api/readiness" {
		return nil, errors.New("CAO readiness URL must be an absolute HTTP(S) /api/readiness URL without credentials, query, or fragment")
	}
	return parsed, nil
}

func validOpenObserveSegment(value string) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && trimmed == value && !strings.ContainsAny(value, "/?#")
}

func validResponseTraceHeaders(headers http.Header) (trace.TraceID, bool) {
	traceID, traceErr := trace.TraceIDFromHex(strings.TrimSpace(headers.Get(TraceIDHeader)))
	_, spanErr := trace.SpanIDFromHex(strings.TrimSpace(headers.Get(SpanIDHeader)))
	return traceID, traceErr == nil && spanErr == nil
}

func smokeSearchContainsTrace(body io.Reader, traceID string) (bool, error) {
	var result openObserveTraceSearch
	if err := json.NewDecoder(io.LimitReader(body, maxSmokeResponseBytes)).Decode(&result); err != nil {
		return false, err
	}
	if strings.EqualFold(result.TraceID, traceID) {
		return true, nil
	}
	for _, hit := range result.Hits {
		if strings.EqualFold(hit.TraceID, traceID) {
			return true, nil
		}
	}
	return false, nil
}

func discardSmokeBody(body io.Reader) error {
	_, err := io.Copy(io.Discard, io.LimitReader(body, maxSmokeResponseBytes))
	return err
}
