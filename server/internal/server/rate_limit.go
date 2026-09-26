package server

import (
	"context"
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
	edgeRateLimit     = 1200
	edgeRateWindow    = time.Minute
	rateLimitTimeout  = 2 * time.Second
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
		a.enforceRateLimit(response, request, next, policy, a.rateLimitSubject(request))
	})
}

// preAuthRateLimit bounds work performed while loading or refreshing a session.
// It deliberately uses only the client address because authenticated identity is
// not available until the access middleware has completed.
func (a *App) preAuthRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if a.oauth == nil || !requiresPreAuthRateLimit(request.URL.Path) || !a.validRateLimitBoundary(request) {
			next.ServeHTTP(response, request)
			return
		}
		policy := requestRatePolicy{name: "edge", capacity: edgeRateLimit, window: edgeRateWindow}
		a.enforceRateLimit(response, request, next, policy, "client:"+a.clientIP(request))
	})
}

// validRateLimitBoundary prevents an invalid Host or forwarded-host request
// from reaching Redis before the access middleware rejects it. It also ensures
// clientIP only sees forwarding headers after the trusted boundary is verified.
func (a *App) validRateLimitBoundary(request *http.Request) bool {
	return validAzureProxyRequest(request, a.proxyPolicy())
}

func (a *App) enforceRateLimit(
	response http.ResponseWriter,
	request *http.Request,
	next http.Handler,
	policy requestRatePolicy,
	subject string,
) {
	sum := sha256.Sum256([]byte(subject))
	key := policy.name + ":" + hex.EncodeToString(sum[:])
	ctx, cancel := context.WithTimeout(request.Context(), rateLimitTimeout)
	defer cancel()
	result, err := a.store.TakeRateLimitToken(ctx, key, policy.capacity, policy.window)
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
}

func requiresPreAuthRateLimit(path string) bool {
	return !publicServiceEndpoint(path) &&
		path != "/api/github/webhook" &&
		!strings.HasPrefix(path, "/auth/login") &&
		!strings.HasPrefix(path, "/auth/logged-out") &&
		!strings.HasPrefix(path, "/auth/callback")
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
	if a.proxyPolicy().TrustForwarded {
		if ip := parseForwardedIP(forwardedHeader(request, "X-Forwarded-For")); ip != nil {
			return ip.String()
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

func parseForwardedIP(value string) net.IP {
	value = strings.TrimSpace(value)
	if ip := net.ParseIP(value); ip != nil {
		return ip
	}
	host, _, err := net.SplitHostPort(value)
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}

func cooldownSeconds(duration time.Duration) int {
	seconds := int((duration + time.Second - 1) / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}
