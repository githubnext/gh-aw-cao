package server

import "testing"

func TestClassifyHostedRedisURLAcceptsTLS(t *testing.T) {
	if reason := classifyHostedRedisURL("rediss", "redis.example.com", false, false); reason != hostedRedisURLRejectionNone {
		t.Fatalf("expected TLS scheme to be accepted, got reason=%s", reason)
	}
}

func TestClassifyHostedRedisURLAcceptsForcedTLSRegardlessOfScheme(t *testing.T) {
	if reason := classifyHostedRedisURL("redis", "redis.example.com", false, true); reason != hostedRedisURLRejectionNone {
		t.Fatalf("expected forced TLS to be accepted, got reason=%s", reason)
	}
}

func TestClassifyHostedRedisURLRejectsPlaintextWithoutOptIn(t *testing.T) {
	if reason := classifyHostedRedisURL("redis", "redis:6379", false, false); reason != hostedRedisURLRejectionPlaintextOptIn {
		t.Fatalf("expected plaintext opt-in rejection, got reason=%s", reason)
	}
}

func TestClassifyHostedRedisURLRejectsNonRedisSchemeEvenWithOptIn(t *testing.T) {
	if reason := classifyHostedRedisURL("http", "redis", true, false); reason != hostedRedisURLRejectionPlaintextOptIn {
		t.Fatalf("expected plaintext opt-in rejection for non-redis scheme, got reason=%s", reason)
	}
}

func TestClassifyHostedRedisURLAcceptsPrivateHostnameWithOptIn(t *testing.T) {
	if reason := classifyHostedRedisURL("redis", "redis.railway.internal", true, false); reason != hostedRedisURLRejectionNone {
		t.Fatalf("expected private hostname to be accepted, got reason=%s", reason)
	}
}

func TestClassifyHostedRedisURLRejectsPublicHostnameEvenWithOptIn(t *testing.T) {
	if reason := classifyHostedRedisURL("redis", "redis.example.com", true, false); reason != hostedRedisURLRejectionPublicHostname {
		t.Fatalf("expected public hostname rejection, got reason=%s", reason)
	}
}

func TestValidateHostedRedisURLRejectsUnparsableURL(t *testing.T) {
	if err := validateHostedRedisURL("redis://%zz", false, false); err == nil {
		t.Fatal("expected unparsable hosted Redis URL to be rejected")
	}
}
