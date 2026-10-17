package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestRoleCredentialIsolation(t *testing.T) {
	for _, name := range []string{"CAO_GATEWAY_RECEIVE_KEY_FILE", "CAO_GATEWAY_DISPATCH_KEY_FILE",
		"CAO_GATEWAY_WEBHOOK_SECRET", "CAO_GATEWAY_PREVIOUS_WEBHOOK_SECRET"} {
		t.Setenv(name, "")
	}
	for _, name := range []string{"CAO_GATEWAY_RECEIVE_KEY_FILE", "CAO_GATEWAY_DISPATCH_KEY_FILE"} {
		t.Setenv(name, "/secret/not-for-ingress")
		err := validateRoleCredentials("receive")
		if err == nil || strings.Contains(err.Error(), "/secret") {
			t.Fatal("receiving credential separation failed")
		}
		t.Setenv(name, "")
	}
	t.Setenv("CAO_GATEWAY_WEBHOOK_SECRET", strings.Repeat("x", 32))
	if err := validateRoleCredentials("dispatch"); err == nil {
		t.Fatal("dispatch process accepted webhook secret")
	}
}

func TestGatewayListenerRequiresTLSOutsideLoopback(t *testing.T) {
	for _, address := range []string{"0.0.0.0:8081", "localhost:8081", "[::]:8081"} {
		err := serve(t.Context(), address, "", "", gateway.PolicySnapshot{}, gateway.PolicyLoader{}, nil, nil)
		if err == nil {
			t.Fatal("unencrypted public listener accepted")
		}
	}
}

func TestPrivateKeyReadIsBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.pem")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", (64<<10)+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadKey(path); err == nil {
		t.Fatal("oversized private key accepted")
	}
}

func TestGatewayRejectsMissingRoleWithoutInfrastructure(t *testing.T) {
	if err := run(t.Context(), []string{"--role=combined"}); err == nil {
		t.Fatal("combined credential role accepted")
	}
}

func TestIngressConcurrencyIsBoundedAndSlotsRecover(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan struct{})
	handler := boundedIngress(make(chan struct{}, 1), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, bounded := r.Context().Deadline(); !bounded {
			t.Error("ingress storage work lacks a deadline")
		}
		entered <- struct{}{}
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	first := httptest.NewRecorder()
	go func() {
		defer close(done)
		handler.ServeHTTP(first, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil))
	}()
	<-entered
	rejected := httptest.NewRecorder()
	handler.ServeHTTP(rejected, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil))
	if rejected.Code != http.StatusServiceUnavailable {
		t.Fatal("saturated ingress did not backpressure")
	}
	close(release)
	<-done
	if first.Code != http.StatusNoContent {
		t.Fatal("admitted request failed")
	}
	recovered := httptest.NewRecorder()
	handler.ServeHTTP(recovered, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil))
	if recovered.Code != http.StatusNoContent {
		t.Fatal("ingress slot leaked")
	}
}
