package simulator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type compiledWindow struct {
	start time.Duration
	end   time.Duration
	spec  APIWindow
}

// NewAPIHandler creates a fake GitHub REST API backed by the scenario's
// time-varying failure windows.
func NewAPIHandler(scenario Scenario, timeScale float64) (http.Handler, error) {
	scenario.defaults()
	if err := scenario.Validate(); err != nil {
		return nil, err
	}
	if timeScale <= 0 || timeScale > 1_000_000 {
		return nil, errors.New("simulator API time scale must be greater than 0 and at most 1000000")
	}
	windows := make([]compiledWindow, 0, len(scenario.API))
	for _, window := range scenario.API {
		start, _ := time.ParseDuration(window.From)
		end, _ := time.ParseDuration(window.To)
		windows = append(windows, compiledWindow{start: start, end: end, spec: window})
	}
	started := time.Now()
	var requests atomic.Uint64
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		count := requests.Add(1)
		elapsed := time.Duration(float64(time.Since(started)) * timeScale)
		window, ok := windowAt(windows, elapsed)
		if !ok {
			writeGitHubSuccess(writer, request, APIWindow{})
			return
		}
		if applyFailure(writer, request, window.spec, count) {
			return
		}
		writeGitHubSuccess(writer, request, window.spec)
	})
	return mux, nil
}

func windowAt(windows []compiledWindow, elapsed time.Duration) (compiledWindow, bool) {
	for _, window := range windows {
		if elapsed >= window.start && elapsed < window.end {
			return window, true
		}
	}
	return compiledWindow{}, false
}

func applyFailure(writer http.ResponseWriter, request *http.Request, window APIWindow, requestNumber uint64) bool {
	switch window.Mode {
	case "healthy":
		return false
	case "latency":
		latency, _ := time.ParseDuration(window.Latency)
		timer := time.NewTimer(latency)
		defer timer.Stop()
		select {
		case <-request.Context().Done():
			return true
		case <-timer.C:
			return false
		}
	case "timeout":
		<-request.Context().Done()
		return true
	case "connection-failure":
		hijacker, ok := writer.(http.Hijacker)
		if !ok {
			http.Error(writer, "simulated connection failure", http.StatusServiceUnavailable)
			return true
		}
		connection, _, err := hijacker.Hijack()
		if err == nil {
			_ = connection.Close()
		}
		return true
	case "intermittent":
		rate := window.FailureRate
		if rate == 0 {
			rate = 0.25
		}
		if window.FailEvery > 0 && requestNumber%uint64(window.FailEvery) == 0 {
			return writeFailure(writer, window)
		}
		if float64(requestNumber%10000)/10000 < rate {
			return writeFailure(writer, window)
		}
		return false
	default:
		return writeFailure(writer, window)
	}
}

func writeFailure(writer http.ResponseWriter, window APIWindow) bool {
	status, supported := map[string]int{
		"rate-limited":         http.StatusTooManyRequests,
		"secondary-rate-limit": http.StatusForbidden,
		"internal-error":       http.StatusInternalServerError,
		"bad-gateway":          http.StatusBadGateway,
		"service-unavailable":  http.StatusServiceUnavailable,
		"unavailable":          http.StatusServiceUnavailable,
		"intermittent":         http.StatusServiceUnavailable,
	}[window.Mode]
	if !supported {
		return false
	}
	if status == http.StatusTooManyRequests || status == http.StatusForbidden {
		resetAfter := window.RateLimitResetAfter
		if resetAfter == 0 {
			resetAfter = 60
		}
		writer.Header().Set("Retry-After", strconv.Itoa(resetAfter))
		writer.Header().Set("X-RateLimit-Limit", "5000")
		writer.Header().Set("X-RateLimit-Remaining", "0")
		writer.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Duration(resetAfter)*time.Second).Unix(), 10))
		if status == http.StatusForbidden {
			writer.Header().Set("X-GitHub-Request-Id", "SIMULATED")
		}
	} else {
		remaining := window.RateLimitRemaining
		if remaining == 0 {
			remaining = 5000
		}
		writer.Header().Set("X-RateLimit-Limit", "5000")
		writer.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	message := "simulated GitHub API failure"
	switch status {
	case http.StatusTooManyRequests:
		message = "API rate limit exceeded"
	case http.StatusForbidden:
		message = "You have exceeded a secondary rate limit"
	}
	_ = json.NewEncoder(writer).Encode(map[string]string{
		"message":           message,
		"documentation_url": "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
	})
	return true
}

func writeGitHubSuccess(writer http.ResponseWriter, request *http.Request, window APIWindow) {
	remaining := window.RateLimitRemaining
	if remaining == 0 {
		remaining = 5000
	}
	resetAfter := window.RateLimitResetAfter
	if resetAfter == 0 {
		resetAfter = 3600
	}
	writer.Header().Set("X-RateLimit-Limit", "5000")
	writer.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	writer.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Duration(resetAfter)*time.Second).Unix(), 10))
	writer.Header().Set("Content-Type", "application/json")
	switch {
	case request.URL.Path == "/rate_limit":
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"resources": map[string]any{"core": map[string]any{
				"limit": 5000, "remaining": remaining,
				"reset": time.Now().Add(time.Duration(resetAfter) * time.Second).Unix(),
			}},
		})
	case request.URL.Path == "/app":
		_ = json.NewEncoder(writer).Encode(map[string]any{"id": 1, "name": "CAO Simulator"})
	case request.Method == http.MethodPost && strings.Contains(request.URL.Path, "/access_tokens"):
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"token":       "simulator-installation-token",
			"expires_at":  time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			"permissions": map[string]string{"actions": "read", "metadata": "read"},
		})
	case strings.HasSuffix(request.URL.Path, "/actions/runs"):
		_ = json.NewEncoder(writer).Encode(map[string]any{"total_count": 0, "workflow_runs": []any{}})
	case strings.HasSuffix(request.URL.Path, "/actions/runs/"):
		writer.WriteHeader(http.StatusNoContent)
	case strings.HasSuffix(request.URL.Path, "/logs"):
		writer.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(request.URL.Path, "/repos/"):
		parts := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
		if len(parts) >= 3 {
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"id":        1,
				"full_name": parts[1] + "/" + parts[2],
				"private":   false,
				"owner":     map[string]string{"login": parts[1]},
			})
			return
		}
		writeNotFound(writer)
	case request.URL.Path == "/graphql":
		_ = json.NewEncoder(writer).Encode(map[string]any{"data": map[string]any{}})
	default:
		writeNotFound(writer)
	}
}

func writeNotFound(writer http.ResponseWriter) {
	writer.WriteHeader(http.StatusNotFound)
	_ = json.NewEncoder(writer).Encode(map[string]string{
		"message": "Not Found",
	})
}

// Listen starts the fake API listener and reports only its address on failure.
func Listen(ctx context.Context, address string, handler http.Handler) (*http.Server, net.Listener, error) {
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", address)
	if err != nil {
		return nil, nil, fmt.Errorf("listen for simulator API: %w", err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	return server, listener, nil
}
