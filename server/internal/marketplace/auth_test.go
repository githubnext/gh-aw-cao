package marketplace

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

func generateTestRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func pkcs8PEM(t *testing.T, key *rsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func pkcs1PEM(key *rsa.PrivateKey) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
}

func TestSecretValueRejectsNamesThatAreNotEnvironmentVariablePatterns(t *testing.T) {
	env := fakeEnv{"literal-token": "value"}.lookup
	if _, err := secretValue(env, "literal-token", "test"); err == nil {
		t.Fatal("expected a non-pattern secret name to be rejected")
	}
}

func TestSecretValueRejectsMissingOrEmptyEnvironmentValue(t *testing.T) {
	env := fakeEnv{"PRESENT_BUT_EMPTY": ""}.lookup
	if _, err := secretValue(env, "MISSING_NAME", "test"); err == nil {
		t.Fatal("expected a missing environment variable to be rejected")
	}
	if _, err := secretValue(env, "PRESENT_BUT_EMPTY", "test"); err == nil {
		t.Fatal("expected an empty environment value to be rejected")
	}
}

func TestSecretValueResolvesAPresentNamedVariable(t *testing.T) {
	env := fakeEnv{"REGISTRY_PAT": "token-value"}.lookup
	value, err := secretValue(env, "REGISTRY_PAT", "test")
	if err != nil {
		t.Fatal(err)
	}
	if value != "token-value" {
		t.Fatalf("unexpected resolved secret: %q", value)
	}
}

func TestRegistryTokenNoneAuthProducesNoToken(t *testing.T) {
	registry := Registry{Auth: Auth{Type: AuthNone}}
	token, err := registryToken(t.Context(), registry, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		t.Fatalf("expected no token for none auth, got: %q", token)
	}
}

func TestRegistryTokenPATResolvesFromNamedEnvironmentVariable(t *testing.T) {
	registry := Registry{Auth: Auth{Type: AuthPAT, Secret: "REGISTRY_PAT"}}
	opts := Options{Env: fakeEnv{"REGISTRY_PAT": "pat-value"}.lookup}
	token, err := registryToken(t.Context(), registry, opts)
	if err != nil {
		t.Fatal(err)
	}
	if token != "pat-value" {
		t.Fatalf("unexpected token: %q", token)
	}
}

func TestRegistryTokenUnsupportedAuthTypeIsRejected(t *testing.T) {
	registry := Registry{Auth: Auth{Type: "oauth"}}
	if _, err := registryToken(t.Context(), registry, Options{}); err == nil {
		t.Fatal("expected an unsupported auth type to be rejected")
	}
}

func TestRegistryTokenGitHubAppExchangesSecretReferencesForAnInstallationToken(t *testing.T) {
	key := generateTestRSAKey(t)
	server := newFakeGitHubServer(t, fakeGitHubConfig{installationToken: "installation-token"})
	registry := Registry{
		APIURL: server.baseURL(),
		Auth: Auth{
			Type:                 AuthGitHubApp,
			AppIDSecret:          "APP_ID",
			PrivateKeySecret:     "APP_KEY",
			InstallationIDSecret: "INSTALLATION_ID",
		},
	}
	opts := Options{
		HTTPClient: insecureTestClient(),
		Env: fakeEnv{
			"APP_ID":          "42",
			"APP_KEY":         string(pkcs8PEM(t, key)),
			"INSTALLATION_ID": "123",
		}.lookup,
	}
	token, err := registryToken(t.Context(), registry, opts)
	if err != nil {
		t.Fatal(err)
	}
	if token != "installation-token" {
		t.Fatalf("unexpected token: %q", token)
	}
	// The JWT minted for the installation-token exchange must have been sent
	// as the bearer, and it must be a well-formed three-segment JWT.
	authorization := server.requestAt(0).Header.Get("Authorization")
	jwt := strings.TrimPrefix(authorization, "Bearer ")
	if len(strings.Split(jwt, ".")) != 3 {
		t.Fatalf("expected a 3-segment JWT, got: %q", authorization)
	}
	if !strings.HasSuffix(server.requestAt(0).URL.Path, "/app/installations/123/access_tokens") {
		t.Fatalf("unexpected installation token URL: %s", server.requestAt(0).URL.Path)
	}
}

func TestRegistryTokenGitHubAppRejectsInvalidTokenResponse(t *testing.T) {
	key := generateTestRSAKey(t)
	server := newFakeGitHubServer(t, fakeGitHubConfig{}) // no installationToken configured -> 404
	registry := Registry{
		APIURL: server.baseURL(),
		Auth: Auth{
			Type: AuthGitHubApp, AppIDSecret: "APP_ID", PrivateKeySecret: "APP_KEY", InstallationIDSecret: "INSTALLATION_ID",
		},
	}
	opts := Options{
		HTTPClient: insecureTestClient(),
		Env: fakeEnv{
			"APP_ID": "42", "APP_KEY": string(pkcs8PEM(t, key)), "INSTALLATION_ID": "123",
		}.lookup,
	}
	if _, err := registryToken(t.Context(), registry, opts); err == nil {
		t.Fatal("expected a non-2xx installation token exchange to fail")
	}
}

func TestAppJWTAcceptsBothPKCS1AndPKCS8PrivateKeys(t *testing.T) {
	key := generateTestRSAKey(t)
	now := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	for name, pemBytes := range map[string][]byte{"pkcs1": pkcs1PEM(key), "pkcs8": pkcs8PEM(t, key)} {
		t.Run(name, func(t *testing.T) {
			jwt, err := appJWT("42", pemBytes, now)
			if err != nil {
				t.Fatal(err)
			}
			if len(strings.Split(jwt, ".")) != 3 {
				t.Fatalf("expected a 3-segment JWT, got: %q", jwt)
			}
		})
	}
}

func TestAppJWTRejectsAnUnparsableKey(t *testing.T) {
	if _, err := appJWT("42", []byte("not a pem key"), time.Now()); err == nil {
		t.Fatal("expected an invalid private key to be rejected")
	}
}
