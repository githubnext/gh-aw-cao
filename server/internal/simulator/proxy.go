package simulator

import (
	"context"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var proxyLog = logger.New("cao:simulator:proxy")

// APIFault affects exactly Count matching requests, then lets recovery traffic
// reach the synthetic upstream. No request bodies or credentials are recorded.
type APIFault struct {
	Path       string `json:"path"`
	Page       int    `json:"page,omitempty"`
	Count      int    `json:"count"`
	Mode       string `json:"mode"`
	RetryAfter int    `json:"retry_after_seconds,omitempty"`
	ResetAt    string `json:"reset_at,omitempty"`
}

func (f APIFault) Validate() error {
	if !strings.HasPrefix(f.Path, "/") || strings.ContainsAny(f.Path, "?#") ||
		f.Page < 0 || f.Count < 1 || f.Count > 1_000_000 || f.RetryAfter < 0 || f.RetryAfter > 86400 {
		return errors.New("invalid simulator proxy fault path, count, page, or backoff")
	}
	if f.ResetAt != "" {
		if _, err := time.Parse(time.RFC3339, f.ResetAt); err != nil {
			return errors.New("proxy reset_at must be an RFC3339 timestamp")
		}
	}
	switch f.Mode {
	case "internal-error", "service-unavailable", "primary-rate-limit", "secondary-rate-limit",
		"unauthorized", "malformed-response", "connection-failure", "timeout", "missing-quota":
		return nil
	default:
		return errors.New("unsupported simulator proxy fault mode")
	}
}

type omitQuotaKey struct{}

type FaultProxy struct {
	proxy  *httputil.ReverseProxy
	local  *LocalTransport
	mu     sync.Mutex
	faults []APIFault
	counts map[string]int
}

func NewFaultProxy(endpoint string) (*FaultProxy, error) {
	target, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New("invalid simulator proxy upstream")
	}
	transport, err := NewLocalTransport(endpoint)
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = transport
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.Request.Context().Value(omitQuotaKey{}) == true {
			for name := range response.Header {
				if strings.HasPrefix(strings.ToLower(name), "x-ratelimit-") {
					response.Header.Del(name)
				}
			}
		}
		return nil
	}
	return &FaultProxy{proxy: proxy, local: transport, counts: map[string]int{}}, nil
}

func (p *FaultProxy) Close() {
	p.local.CloseIdleConnections()
}

func (p *FaultProxy) Inject(fault APIFault) error {
	if err := fault.Validate(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.faults = append(p.faults, fault)
	return nil
}

func (p *FaultProxy) RequestCount(path string, page int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.counts[path+":"+strconv.Itoa(page)]
}

// selectFault finds the first fault in faults matching path and page with
// remaining count, decrements its count, and reports whether a match was
// found. It is a pure function extracted from ServeHTTP's inline
// lock-protected loop so the first-match-wins and count-decrement behavior
// is independently testable against a plain []APIFault, without an HTTP
// request, response recorder, or the proxy's mutex.
func selectFault(faults []APIFault, path string, page int) (APIFault, bool) {
	for index := range faults {
		fault := &faults[index]
		if fault.Count > 0 && fault.Path == path && (fault.Page == 0 || fault.Page == page) {
			selected := *fault
			fault.Count--
			return selected, true
		}
	}
	return APIFault{}, false
}

func (p *FaultProxy) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	path := strings.TrimPrefix(request.URL.Path, "/api/v3")
	page, _ := strconv.Atoi(request.URL.Query().Get("page"))
	p.mu.Lock()
	p.counts[path+":"+strconv.Itoa(page)]++
	selected, matched := selectFault(p.faults, path, page)
	p.mu.Unlock()
	if !matched {
		proxyLog.Printf("proxy request passthrough page=%d", page)
		p.proxy.ServeHTTP(writer, request)
		return
	}
	proxyLog.Printf("proxy fault injected mode=%s page=%d", selected.Mode, page)
	if selected.ResetAt != "" {
		reset, _ := time.Parse(time.RFC3339, selected.ResetAt)
		writer.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		writer.Header().Set("X-RateLimit-Resource", "core")
	}
	switch selected.Mode {
	case "missing-quota":
		p.proxy.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), omitQuotaKey{}, true)))
	case "malformed-response":
		setRateHeaders(writer, successRate(APIWindow{}, nil))
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"workflow_runs":`))
	case "unauthorized":
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"message":"simulated unauthorized"}`))
	case "primary-rate-limit":
		reset := selected.RetryAfter
		if reset == 0 {
			reset = 60
		}
		resetAt := time.Now().Add(time.Duration(reset) * time.Second)
		if selected.ResetAt != "" {
			resetAt, _ = time.Parse(time.RFC3339, selected.ResetAt)
		}
		writePrimaryRateLimit(writer, rateHeaders{
			limit: 5000, remaining: 0, used: 5000, reset: resetAt,
		})
	default:
		applyFailure(writer, request, APIWindow{
			Mode: selected.Mode, RateLimitResetAfter: selected.RetryAfter,
		}, 1)
	}
}
