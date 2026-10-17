package webhookgateway

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func signWebhook(body, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestIngressSignatureRotation(t *testing.T) {
	body := []byte(`{"action":"created"}`)
	for _, secret := range []string{"current", "previous"} {
		if !validSignature(body, signWebhook(body, []byte(secret)), []byte("current"), []byte("previous")) {
			t.Fatal("rotation key rejected")
		}
	}
	for _, signature := range []string{"", "sha1=ab", "sha256=xx", signWebhook([]byte("tampered"), []byte("current")), signWebhook(body, nil)} {
		if validSignature(body, signature, []byte("current"), nil) {
			t.Fatal("invalid signature accepted")
		}
	}
	if validSignature(body, signWebhook(body, nil), nil, nil) {
		t.Fatal("empty configured keys authenticated")
	}
}

func TestIngressRequestBounds(t *testing.T) {
	newRequest := func(body string) *http.Request {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-GitHub-Delivery", "delivery")
		r.Header.Set("X-GitHub-Event", "projects_v2_item")
		r.Header.Set("X-Hub-Signature-256", signWebhook([]byte(body), []byte("key")))
		return r
	}
	for _, size := range []int{MaxWebhookBodyBytes, MaxWebhookBodyBytes + 1} {
		_, err := readWebhook(httptest.NewRecorder(), newRequest(strings.Repeat("x", size)))
		if (err == nil) != (size == MaxWebhookBodyBytes) {
			t.Fatalf("body size %d: %v", size, err)
		}
	}
	r := newRequest("{}")
	r.Header.Add("X-GitHub-Delivery", "duplicate")
	if _, err := readWebhook(httptest.NewRecorder(), r); err == nil {
		t.Fatal("duplicate delivery headers accepted")
	}
	r = newRequest("{}")
	r.Header.Set("X-GitHub-Event", strings.Repeat("x", 65))
	if _, err := readWebhook(httptest.NewRecorder(), r); err == nil {
		t.Fatal("oversized event header accepted")
	}
	r = newRequest("{}")
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if _, err := readWebhook(httptest.NewRecorder(), r); err == nil {
		t.Fatal("non-JSON body accepted")
	}
}
