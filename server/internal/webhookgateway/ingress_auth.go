package webhookgateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
)

const MaxWebhookBodyBytes = 1 << 20

var errInvalidWebhook = errors.New("invalid webhook request")

func readWebhook(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if r.Method != http.MethodPost {
		return nil, errInvalidWebhook
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		return nil, errInvalidWebhook
	}
	if !validHeader(r.Header, "X-GitHub-Delivery", 128) ||
		!validHeader(r.Header, "X-GitHub-Event", 64) ||
		!validHeader(r.Header, "X-Hub-Signature-256", 71) {
		return nil, errInvalidWebhook
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxWebhookBodyBytes))
	if err != nil {
		return nil, err
	}
	return body, nil
}

func validHeader(headers http.Header, key string, limit int) bool {
	values := headers.Values(key)
	if len(values) != 1 || len(values[0]) == 0 || len(values[0]) > limit {
		return false
	}
	for _, char := range values[0] {
		if char < 33 || char > 126 {
			return false
		}
	}
	return true
}

func validSignature(body []byte, signature string, current, previous []byte) bool {
	if !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	supplied, err := hex.DecodeString(strings.TrimPrefix(signature, "sha256="))
	if err != nil || len(supplied) != sha256.Size {
		return false
	}
	// Evaluate both keys even if the current key matched.
	match := 0
	for _, secret := range [][]byte{current, previous} {
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write(body)
		equal := hmac.Equal(supplied, mac.Sum(nil))
		if len(secret) != 0 && equal {
			match |= 1
		}
	}
	return match == 1
}
