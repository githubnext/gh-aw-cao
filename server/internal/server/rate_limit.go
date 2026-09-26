package server

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	generalRateLimit  = 120
	generalRateWindow = time.Minute
	queryRateLimit    = 30
	queryRateWindow   = time.Minute
	authRateLimit     = 10
	authRateWindow    = 5 * time.Minute
)

type requestRatePolicy struct {
	name     string
	capacity int
	window   time.Duration
}

func (a *App) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		policy, limited := ratePolicy(request)
		if !limited {
			next.ServeHTTP(response, request)
			return
		}
		subject := a.rateLimitSubject(request)
		sum := sha256.Sum256([]byte(subject))
		key := policy.name + ":" + hex.EncodeToString(sum[:])
		result, err := a.store.TakeRateLimitToken(request.Context(), key, policy.capacity, policy.window)
		if err != nil {
			serverLog.Printf("rate limit unavailable policy=%s", policy.name)
			writeError(response, http.StatusServiceUnavailable, "request rate limiter is unavailable")
			return
		}
		resetSeconds := cooldownSeconds(result.ResetAfter)
		response.Header().Set("RateLimit-Limit", strconv.Itoa(policy.capacity))
		response.Header().Set("RateLimit-Remaining", strconv.FormatInt(result.Remaining, 10))
		response.Header().Set("RateLimit-Reset", strconv.Itoa(resetSeconds))
		response.Header().Set(
			"RateLimit-Policy",
			strconv.Itoa(policy.capacity)+";w="+strconv.FormatInt(int64(policy.window/time.Second), 10),
		)
		if !result.Allowed {
			response.Header().Set("Retry-After", strconv.Itoa(cooldownSeconds(result.RetryAfter)))
			writeError(response, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func ratePolicy(request *http.Request) (requestRatePolicy, bool) {
	switch {
	case publicServiceEndpoint(request.URL.Path), request.URL.Path == "/api/github/webhook":
		return requestRatePolicy{}, false
	case request.URL.Path == "/auth/login", request.URL.Path == "/auth/callback":
		return requestRatePolicy{name: "auth", capacity: authRateLimit, window: authRateWindow}, true
	case request.URL.Path == "/api/v1/query":
		return requestRatePolicy{name: "query", capacity: queryRateLimit, window: queryRateWindow}, true
	case strings.HasPrefix(request.URL.Path, "/api/"), strings.HasPrefix(request.URL.Path, "/auth/"):
		return requestRatePolicy{name: "general", capacity: generalRateLimit, window: generalRateWindow}, true
	default:
		return requestRatePolicy{}, false
	}
}

func (a *App) rateLimitSubject(request *http.Request) string {
	if session, ok := request.Context().Value(oauthSessionContextKey{}).(oauthSession); ok &&
		strings.TrimSpace(session.Login) != "" {
		return "user:" + strings.ToLower(strings.TrimSpace(session.Login))
	}
	return "client:" + a.clientIP(request)
}

func (a *App) clientIP(request *http.Request) string {
	policy := a.config.Proxy
	if len(policy.AllowedHosts) == 0 {
		policy = a.config.AzureProxy
	}
	if policy.TrustForwarded {
		for _, candidate := range strings.Split(request.Header.Get("X-Forwarded-For"), ",") {
			if ip := net.ParseIP(strings.TrimSpace(candidate)); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err == nil {
		if ip := net.ParseIP(host); ip != nil {
			return ip.String()
		}
		return host
	}
	if ip := net.ParseIP(request.RemoteAddr); ip != nil {
		return ip.String()
	}
	return "unknown"
}

func cooldownSeconds(duration time.Duration) int {
	seconds := int((duration + time.Second - 1) / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}
