package webhookgateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"
)

// AuthenticateExternal verifies the native authentication scheme before interpreting
// receiver evidence.
func AuthenticateExternal(source ExternalSource, request *http.Request, body, current, previous []byte, now time.Time, limits Limits) (Event, error) {
	if validateExternalSource(source) != nil || !now.Before(source.ExpiresAt) ||
		len(current) < 32 || len(current) > 512 ||
		len(previous) > 0 && (len(previous) < 32 || len(previous) > 512) {
		return Event{}, ErrUnauthorized
	}
	var signatureHeader string
	switch source.Event {
	case "jira_issue":
		signatureHeader = "X-Hub-Signature"
	case "linear_issue":
		signatureHeader = "Linear-Signature"
	case "azure_devops_issue":
		signatureHeader = "Authorization"
	default:
		return Event{}, ErrUnauthorized
	}
	validAuthHeader := validHeader(request.Header, signatureHeader, 1024)
	if source.Event == "azure_devops_issue" {
		// Basic has one required space; the exact encoded credential is checked below.
		validAuthHeader = len(request.Header.Values(signatureHeader)) == 1 && len(request.Header.Get(signatureHeader)) <= 1024
	}
	if !validAuthHeader {
		return Event{}, ErrUnauthorized
	}
	signature := request.Header.Get(signatureHeader)
	valid := false
	if source.Event == "azure_devops_issue" {
		for _, secret := range [][]byte{current, previous} {
			expected := "Basic " + base64.StdEncoding.EncodeToString(append([]byte("cao:"), secret...))
			actualHash, expectedHash := sha256.Sum256([]byte(signature)), sha256.Sum256([]byte(expected))
			if hmac.Equal(actualHash[:], expectedHash[:]) && len(secret) != 0 {
				valid = true
			}
		}
	} else {
		if source.Event == "linear_issue" {
			signature = "sha256=" + signature
		}
		valid = validSignature(body, signature, current, previous)
	}
	if !valid {
		return Event{}, ErrUnauthorized
	}
	l, err := resolveLimits(limits)
	if err != nil {
		return Event{}, err
	}
	root, err := boundedJSON(body, l.MaxEventBytes, l)
	if err != nil {
		return Event{}, err
	}
	var delivery string
	switch source.Event {
	case "jira_issue", "linear_issue":
		header := "X-Atlassian-Webhook-Identifier"
		if source.Event == "linear_issue" {
			header = "Linear-Delivery"
		}
		if !validHeader(request.Header, header, 128) {
			return Event{}, ErrInvalid
		}
		delivery = request.Header.Get(header)
	default:
		delivery = textAt(root, "id")
	}
	if !identifier(delivery) {
		return Event{}, ErrInvalid
	}
	if source.Event == "linear_issue" {
		field, maximumAge := "webhookTimestamp", time.Minute
		stamp, ok := at(root, field).(json.Number)
		if !ok {
			return Event{}, ErrUnauthorized
		}
		millis, err := stamp.Int64()
		if err != nil || millis <= 0 {
			return Event{}, ErrUnauthorized
		}
		delta := now.Sub(time.UnixMilli(millis))
		if delta < -maximumAge || delta > maximumAge {
			return Event{}, ErrUnauthorized
		}
	}
	// Providers have tenant-local delivery identities. Namespace them before dedup.
	delivery = MetadataDigest([]byte(source.ID + "\x00" + delivery))
	return parseExternalEvent(source, delivery, body, limits)
}
