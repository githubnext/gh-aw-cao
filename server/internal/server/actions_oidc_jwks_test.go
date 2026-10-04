package server

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"testing"
)

// encodedTestRSAKey mints a real RSA key and returns its base64url-encoded
// modulus and exponent, matching the encoding GitHub's Actions OIDC JWKS
// endpoint uses.
func encodedTestRSAKey(t *testing.T) (modulus, exponent string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())
}

func TestSelectActionsOIDCKeyMatchesByIDTypeUseAndAlgorithm(t *testing.T) {
	modulus, exponent := encodedTestRSAKey(t)
	keys := []jwksKey{
		{ID: "other-key", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: modulus, Exponent: exponent},
		{ID: "test-key", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: modulus, Exponent: exponent},
	}
	key, err := selectActionsOIDCKey(keys, "test-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key == nil || key.E <= 0 || key.N == nil {
		t.Fatalf("invalid resolved key: %+v", key)
	}
}

func TestSelectActionsOIDCKeyAcceptsBlankAlgorithm(t *testing.T) {
	modulus, exponent := encodedTestRSAKey(t)
	keys := []jwksKey{{ID: "test-key", Type: "RSA", Use: "sig", Alg: "", Modulus: modulus, Exponent: exponent}}
	if _, err := selectActionsOIDCKey(keys, "test-key"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSelectActionsOIDCKeyRejectsUnknownKeyID(t *testing.T) {
	modulus, exponent := encodedTestRSAKey(t)
	keys := []jwksKey{{ID: "test-key", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: modulus, Exponent: exponent}}
	if _, err := selectActionsOIDCKey(keys, "missing-key"); err == nil {
		t.Fatal("expected an error for an unknown key id")
	}
}

func TestSelectActionsOIDCKeyRejectsNonRSAOrWrongUseOrAlgorithm(t *testing.T) {
	modulus, exponent := encodedTestRSAKey(t)
	for _, test := range []struct {
		name string
		key  jwksKey
	}{
		{"wrong type", jwksKey{ID: "k", Type: "EC", Use: "sig", Alg: "RS256", Modulus: modulus, Exponent: exponent}},
		{"wrong use", jwksKey{ID: "k", Type: "RSA", Use: "enc", Alg: "RS256", Modulus: modulus, Exponent: exponent}},
		{"wrong algorithm", jwksKey{ID: "k", Type: "RSA", Use: "sig", Alg: "RS384", Modulus: modulus, Exponent: exponent}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := selectActionsOIDCKey([]jwksKey{test.key}, "k"); err == nil {
				t.Fatal("expected an error for a mismatched key")
			}
		})
	}
}

func TestSelectActionsOIDCKeyRejectsMalformedEncoding(t *testing.T) {
	_, exponent := encodedTestRSAKey(t)
	keys := []jwksKey{{ID: "k", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: "not-base64url!!", Exponent: exponent}}
	if _, err := selectActionsOIDCKey(keys, "k"); err == nil {
		t.Fatal("expected an error for a malformed modulus")
	}
}

func TestSelectActionsOIDCKeyRejectsOutOfBoundsModulusLength(t *testing.T) {
	short := base64.RawURLEncoding.EncodeToString(make([]byte, 64))
	_, exponent := encodedTestRSAKey(t)
	keys := []jwksKey{{ID: "k", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: short, Exponent: exponent}}
	if _, err := selectActionsOIDCKey(keys, "k"); err == nil {
		t.Fatal("expected an error for a too-short modulus")
	}
}

func TestSelectActionsOIDCKeyRejectsEvenExponent(t *testing.T) {
	modulus, _ := encodedTestRSAKey(t)
	even := base64.RawURLEncoding.EncodeToString(big.NewInt(4).Bytes())
	keys := []jwksKey{{ID: "k", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: modulus, Exponent: even}}
	if _, err := selectActionsOIDCKey(keys, "k"); err == nil {
		t.Fatal("expected an error for an even public exponent")
	}
}

func TestSelectActionsOIDCKeyRejectsTooSmallExponent(t *testing.T) {
	modulus, _ := encodedTestRSAKey(t)
	one := base64.RawURLEncoding.EncodeToString(big.NewInt(1).Bytes())
	keys := []jwksKey{{ID: "k", Type: "RSA", Use: "sig", Alg: "RS256", Modulus: modulus, Exponent: one}}
	if _, err := selectActionsOIDCKey(keys, "k"); err == nil {
		t.Fatal("expected an error for an exponent below the minimum")
	}
}

func TestSelectActionsOIDCKeyRejectsNoMatch(t *testing.T) {
	if _, err := selectActionsOIDCKey(nil, "k"); err == nil {
		t.Fatal("expected an error for an empty key set")
	}
}
