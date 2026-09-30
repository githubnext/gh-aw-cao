package server

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	maxCORSAllowedOrigins = 32
	defaultCORSMaxAge     = 600
	maxCORSMaxAge         = 86400
	corsAllowedMethods    = "GET, HEAD, POST"
	corsAllowedHeaders    = "Content-Type, X-CSRF-Token, Traceparent"
)

// CORSPolicy is the reviewed cross-origin policy from
// control-plane.web.host.cors. The zero value keeps the dashboard strictly
// same-origin: no Access-Control-* headers are ever emitted.
type CORSPolicy struct {
	AllowedOrigins   []string
	AllowCredentials bool
	MaxAge           int
}

type corsPolicyDocument struct {
	AllowedOrigins   []string `json:"allowed-origins"`
	AllowCredentials bool     `json:"allow-credentials"`
	MaxAge           *int     `json:"max-age"`
}

func (document corsPolicyDocument) resolve() (CORSPolicy, error) {
	policy := CORSPolicy{
		AllowedOrigins:   document.AllowedOrigins,
		AllowCredentials: document.AllowCredentials,
		MaxAge:           defaultCORSMaxAge,
	}
	if document.MaxAge != nil {
		if *document.MaxAge < 1 {
			return CORSPolicy{}, fmt.Errorf("cors max-age must be between 1 and %d seconds", maxCORSMaxAge)
		}
		policy.MaxAge = *document.MaxAge
	}
	return policy.normalize()
}

// normalize validates the policy and returns a copy with canonical,
// deduplicated origins. It fails closed on wildcards, opaque origins, paths,
// credentials in the origin, or plaintext origins other than loopback.
func (policy CORSPolicy) normalize() (CORSPolicy, error) {
	if len(policy.AllowedOrigins) == 0 {
		if policy.AllowCredentials {
			return CORSPolicy{}, errors.New("cors allow-credentials requires allowed-origins")
		}
		return CORSPolicy{}, nil
	}
	if len(policy.AllowedOrigins) > maxCORSAllowedOrigins {
		return CORSPolicy{}, fmt.Errorf("cors allowed-origins accepts at most %d origins", maxCORSAllowedOrigins)
	}
	if policy.MaxAge == 0 {
		policy.MaxAge = defaultCORSMaxAge
	}
	if policy.MaxAge < 0 || policy.MaxAge > maxCORSMaxAge {
		return CORSPolicy{}, fmt.Errorf("cors max-age must be between 1 and %d seconds", maxCORSMaxAge)
	}
	seen := map[string]bool{}
	origins := make([]string, 0, len(policy.AllowedOrigins))
	for _, value := range policy.AllowedOrigins {
		origin, err := canonicalCORSOrigin(value)
		if err != nil {
			return CORSPolicy{}, err
		}
		if !seen[origin] {
			seen[origin] = true
			origins = append(origins, origin)
		}
	}
	policy.AllowedOrigins = origins
	return policy, nil
}

func canonicalCORSOrigin(value string) (string, error) {
	invalid := errors.New("cors allowed-origins entries must be exact https origins such as https://example.com")
	value = strings.TrimSpace(value)
	if value == "" || strings.Contains(value, "*") {
		return "", invalid
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil || parsed.Host == "" ||
		parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		strings.HasSuffix(value, "?") || strings.HasSuffix(value, "#") ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", invalid
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Host)
	switch scheme {
	case "https":
	case "http":
		hostname := strings.Trim(parsed.Hostname(), "[]")
		ip := net.ParseIP(hostname)
		if !strings.EqualFold(hostname, "localhost") && (ip == nil || !ip.IsLoopback()) {
			return "", invalid
		}
	default:
		return "", invalid
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", invalid
		}
		if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
			host = strings.ToLower(parsed.Hostname())
			if strings.Contains(host, ":") {
				host = "[" + host + "]"
			}
		}
	}
	return scheme + "://" + host, nil
}

func (policy CORSPolicy) allows(origin string) bool {
	for _, allowed := range policy.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

// cors applies the reviewed cross-origin policy before authentication so a
// preflight never needs credentials. Requests from origins outside the
// allowlist receive no Access-Control-* headers and are otherwise unchanged.
func (a *App) cors(next http.Handler) http.Handler {
	policy := a.config.CORS
	if len(policy.AllowedOrigins) == 0 {
		return next
	}
	maxAge := strconv.Itoa(policy.MaxAge)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		headers := response.Header()
		headers.Add("Vary", "Origin")
		origin := request.Header.Get("Origin")
		if origin == "" || !policy.allows(origin) || !a.validCORSRequestHost(request) {
			next.ServeHTTP(response, request)
			return
		}
		headers.Set("Access-Control-Allow-Origin", origin)
		if policy.AllowCredentials {
			headers.Set("Access-Control-Allow-Credentials", "true")
		}
		if requested := request.Header.Get("Access-Control-Request-Method"); request.Method == http.MethodOptions && requested != "" {
			headers.Add("Vary", "Access-Control-Request-Method")
			headers.Add("Vary", "Access-Control-Request-Headers")
			if requested != http.MethodGet && requested != http.MethodHead && requested != http.MethodPost {
				response.WriteHeader(http.StatusNoContent)
				return
			}
			headers.Set("Access-Control-Allow-Methods", corsAllowedMethods)
			headers.Set("Access-Control-Allow-Headers", corsAllowedHeaders)
			headers.Set("Access-Control-Max-Age", maxAge)
			response.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(response, request)
	})
}

// validCORSRequestHost applies the same host validation as the access
// middleware so a preflight answered before authentication can never succeed
// for a request that access control would reject as misdirected.
func (a *App) validCORSRequestHost(request *http.Request) bool {
	if a.oauth != nil {
		return validProxyRequest(request, a.proxyPolicy())
	}
	return validLocalRequestHost(request.Host)
}
