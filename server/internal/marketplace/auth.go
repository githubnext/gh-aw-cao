package marketplace

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var authLog = logger.New("cao:marketplace:auth")

// EnvLookup resolves an environment variable by name, matching
// os.LookupEnv's signature so tests can substitute a fake environment
// without mutating process state.
type EnvLookup func(name string) (string, bool)

func secretValue(env EnvLookup, name, field string) (string, error) {
	if !secretNamePattern.MatchString(name) {
		return "", fmt.Errorf("%s secret must reference an environment variable name", field)
	}
	value, ok := env(name)
	if !ok || value == "" {
		return "", fmt.Errorf("%s secret is unavailable", field)
	}
	return value, nil
}

// registryToken resolves the bearer token a registry's configured auth
// requires, reading only named secrets from the environment. It never
// returns or logs the secret names or values alongside the resolved token.
func registryToken(ctx context.Context, registry Registry, opts Options) (string, error) {
	token, err := resolveRegistryToken(ctx, registry, opts)
	// One resolution per registry is a meaningful boundary worth observing,
	// and registryToken is never called from a per-package or polling loop.
	authLog.Printf("resolved registry token auth_type=%s ok=%t", authTypeLabel(registry.Auth.Type), err == nil)
	return token, err
}

func resolveRegistryToken(ctx context.Context, registry Registry, opts Options) (string, error) {
	switch registry.Auth.Type {
	case "", AuthNone:
		return "", nil
	case AuthPAT:
		return secretValue(opts.env(), registry.Auth.Secret, "registry PAT")
	case AuthGitHubApp:
		return exchangeGitHubAppToken(ctx, registry, opts)
	default:
		return "", fmt.Errorf("registry authentication type %q is unsupported", registry.Auth.Type)
	}
}

// authTypeLabel normalizes an empty Auth.Type to AuthNone's label, so the
// log line always names a concrete auth type instead of an empty string.
func authTypeLabel(authType AuthType) AuthType {
	if authType == "" {
		return AuthNone
	}
	return authType
}

// exchangeGitHubAppToken resolves a registry's GitHub App credential
// secrets, mints a short-lived JWT, and exchanges it for an installation
// access token. It is a pure orchestration step (its GitHub call goes
// through opts.httpClient()) so the exchange is testable with a fake GitHub
// server without exercising registryToken's other auth branches.
func exchangeGitHubAppToken(ctx context.Context, registry Registry, opts Options) (string, error) {
	appID, err := secretValue(opts.env(), registry.Auth.AppIDSecret, "registry GitHub App id")
	if err != nil {
		return "", err
	}
	privateKey, err := secretValue(opts.env(), registry.Auth.PrivateKeySecret, "registry GitHub App private key")
	if err != nil {
		return "", err
	}
	installationID, err := secretValue(opts.env(), registry.Auth.InstallationIDSecret, "registry GitHub App installation id")
	if err != nil {
		return "", err
	}
	jwt, err := appJWT(appID, []byte(privateKey), opts.now())
	if err != nil {
		return "", err
	}
	base := apiBase(registry)
	payload, err := githubJSON(ctx, opts, http.MethodPost, base+"/app/installations/"+pathEscape(installationID)+"/access_tokens", jwt)
	if err != nil {
		return "", err
	}
	token, _ := payload["token"].(string)
	if token == "" {
		return "", errors.New("registry GitHub App token response is invalid")
	}
	return token, nil
}

// appJWT mints a short-lived GitHub App JWT (RS256), mirroring the appJwt
// helper in activity/marketplace.mjs so both backends authenticate the same
// way. now is injectable for deterministic tests.
func appJWT(appID string, privateKeyPEM []byte, now time.Time) (string, error) {
	key, err := parseRSAPrivateKey(privateKeyPEM)
	if err != nil {
		return "", fmt.Errorf("parse registry GitHub App private key: %w", err)
	}
	issuedAt := now.Add(-60 * time.Second).Unix()
	header := base64URLEncode([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payloadJSON, err := json.Marshal(map[string]any{
		"iat": issuedAt,
		"exp": issuedAt + 9*60,
		"iss": appID,
	})
	if err != nil {
		return "", err
	}
	payload := base64URLEncode(payloadJSON)
	signingInput := header + "." + payload
	hashed := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hashed[:])
	if err != nil {
		return "", fmt.Errorf("sign registry GitHub App JWT: %w", err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func base64URLEncode(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

// parseRSAPrivateKey accepts both PKCS#1 ("RSA PRIVATE KEY") and PKCS#8
// ("PRIVATE KEY") PEM encodings, since GitHub App private keys are usually
// distributed as PKCS#1 but generated test keys are commonly PKCS#8.
func parseRSAPrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("private key is not valid PEM")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("private key is not a supported RSA format")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not RSA")
	}
	return key, nil
}
