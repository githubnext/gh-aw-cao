package githubapp

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

// This provider models registration/revocation, not GitHub's actual behavior.
func TestLocalAppKeyRolloverAndRevocationWithFakeProvider(t *testing.T) {
	oldPEM := gatewayTestKey(t)
	block, _ := pem.Decode(oldPEM)
	oldKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	newKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	newPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(newKey)})
	oldReport, err := CheckPrivateKey(oldPEM, "", "")
	if err != nil {
		t.Fatal(err)
	}
	newReport, err := CheckPrivateKey(newPEM, "", oldReport.PublicKeySHA256)
	if err != nil {
		t.Fatal(err)
	}
	var revokedOld, denied atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3/app/installations/9/access_tokens" {
			t.Error("unexpected request outside App-token mint boundary")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		rawJWT := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		validFor := func(key *rsa.PrivateKey) bool {
			token, parseErr := jwt.Parse(rawJWT, func(_ *jwt.Token) (any, error) {
				return &key.PublicKey, nil
			}, jwt.WithValidMethods([]string{"RS256"}))
			if parseErr != nil || !token.Valid {
				return false
			}
			claims, ok := token.Claims.(jwt.MapClaims)
			return ok && claims["iss"] == "11"
		}
		if denied.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if !validFor(newKey) && (revokedOld.Load() || !validFor(oldKey)) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"token":"synthetic-installation-token","expires_at":%q,"permissions":{"contents":"read"},"repositories":[{"name":"api"}]}`,
			time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	}))
	defer provider.Close()
	newClient := func(content []byte) *Client {
		t.Helper()
		client, newErr := New(Config{AppID: 11, PrivateKeyPEM: content, BaseURL: provider.URL + "/api/v3/", RequestTimeout: time.Second})
		if newErr != nil {
			t.Fatal(newErr)
		}
		return client
	}
	oldClient, replacement := newClient(oldPEM), newClient(newPEM)
	scope := TokenScope{Repositories: []string{"api"}, Permissions: map[string]string{"contents": "read"}}
	mint := func(client *Client, wantSuccess bool) {
		t.Helper()
		_, mintErr := client.MintScopedToken(t.Context(), 9, scope)
		if (mintErr == nil) != wantSuccess {
			t.Fatalf("mint success=%t, expected=%t", mintErr == nil, wantSuccess)
		}
	}
	mint(oldClient, true)
	mint(replacement, true)
	revokedOld.Store(true)
	mint(oldClient, false)
	mint(replacement, true)
	denied.Store(true)
	mint(replacement, false)
	// Offline validity must not be mistaken for current registration/authority.
	if _, err := CheckPrivateKey(newPEM, newReport.PublicKeySHA256, oldReport.PublicKeySHA256); err != nil {
		t.Fatal("provider refusal must not alter offline key-material validity")
	}
	provider.Close()
	mint(replacement, false)
}
