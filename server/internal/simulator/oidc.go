package simulator

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

const actionsIssuer = "https://token.actions.githubusercontent.com"

// Trace records only bounded stage names, HTTP statuses and sequence numbers,
// never credentials, claims, request bodies or remote response bodies.
type Trace struct {
	mu     sync.Mutex
	events []TraceEvent
}

type TraceEvent struct {
	Sequence int    `json:"sequence"`
	Stage    string `json:"stage"`
	Status   int    `json:"status"`
}

func (t *Trace) record(stage string, status int) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.events) < 10000 {
		t.events = append(t.events, TraceEvent{len(t.events) + 1, stage, status})
	} else if len(t.events) == 10000 {
		t.events = append(t.events, TraceEvent{10001, "trace.truncated", 0})
	}
}

func (t *Trace) Events() []TraceEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]TraceEvent{}, t.events...)
}

// OIDCBroker models the Actions runner token endpoint, not a production issuer.
// Its signing key is ephemeral and must only be trusted by test-owned verifiers.
type OIDCBroker struct {
	key   *rsa.PrivateKey
	now   func() time.Time
	trace *Trace
	mu    sync.Mutex
	runs  map[string]jwt.MapClaims
}

func NewOIDCBroker(now func() time.Time, trace *Trace) (*OIDCBroker, error) {
	if now == nil {
		return nil, errors.New("simulator OIDC clock is required")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, errors.New("create simulator OIDC signing key")
	}
	return &OIDCBroker{key: key, now: now, trace: trace, runs: make(map[string]jwt.MapClaims)}, nil
}

// Register binds an opaque bootstrap credential to one immutable run. HTTP
// callers choose only the audience; they cannot supply their own run claims.
func (b *OIDCBroker) Register(claims map[string]string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.runs) >= 1024 || len(claims) > 32 {
		return "", errors.New("simulator OIDC run capacity exceeded")
	}
	snapshot := jwt.MapClaims{}
	for name, value := range claims {
		if len(name) > 64 || len(value) > 2048 {
			return "", errors.New("simulator OIDC claim exceeds limit")
		}
		switch name {
		case "iss", "aud", "iat", "nbf", "exp":
			return "", errors.New("simulator OIDC reserved claim")
		}
		snapshot[name] = value
	}
	credential := rand.Text()
	b.runs[credential] = snapshot
	return credential, nil
}

func (b *OIDCBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	status := http.StatusNotFound
	stage := "oidc.not_found"
	defer func() { b.trace.record(stage, status) }()
	if r.Method != http.MethodGet {
		status = http.StatusMethodNotAllowed
		w.WriteHeader(status)
		return
	}
	switch r.URL.Path {
	case "/.well-known/jwks":
		stage, status = "oidc.jwks", http.StatusOK
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{
			"kid": "local-actions", "kty": "RSA", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(b.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(b.key.E)).Bytes()),
		}}})
	case "/token":
		stage = "oidc.token"
		b.mu.Lock()
		snapshot := b.runs[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		claims := jwt.MapClaims{}
		for name, value := range snapshot {
			claims[name] = value
		}
		b.mu.Unlock()
		audience := r.URL.Query()["audience"]
		if snapshot == nil || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") ||
			len(r.Header.Values("Authorization")) != 1 || len(audience) != 1 ||
			len(audience[0]) == 0 || len(audience[0]) > 2048 || len(r.URL.RawQuery) > 8192 {
			status = http.StatusForbidden
			w.WriteHeader(status)
			return
		}
		now := b.now().Unix()
		claims["iss"], claims["aud"] = actionsIssuer, audience[0]
		claims["iat"], claims["nbf"], claims["exp"] = now, now, now+300
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		token.Header["kid"] = "local-actions"
		raw, err := token.SignedString(b.key)
		if err != nil {
			status = http.StatusInternalServerError
			w.WriteHeader(status)
			return
		}
		status = http.StatusOK
		_ = json.NewEncoder(w).Encode(map[string]string{"value": raw})
	default:
		w.WriteHeader(status)
	}
}
