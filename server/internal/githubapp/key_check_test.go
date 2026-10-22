package githubapp

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"strings"
	"testing"
)

func TestCheckPrivateKeyPinsPublicIdentityAcrossEncodings(t *testing.T) {
	content := gatewayTestKey(t)
	block, _ := pem.Decode(content)
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(publicDER)
	expected := hex.EncodeToString(digest[:])
	for _, encoded := range [][]byte{content, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})} {
		result, err := CheckPrivateKey(encoded, expected, strings.Repeat("0", 64))
		if err != nil {
			t.Fatal(err)
		}
		if result.PublicKeySHA256 != expected || result.Algorithm != "RS256" || result.Bits != 2048 ||
			!result.ExpectedKeyChecked || !result.RotationKeyChecked || result.Scope != "offline-key-material-only" {
			t.Fatalf("unexpected public report: %+v", result)
		}
		if _, err := CheckPrivateKey(encoded, "", expected); err == nil {
			t.Fatal("re-encoding the same key must not pass rollover")
		}
	}
	result, err := CheckPrivateKey(content, "", "")
	if err != nil || result.ExpectedKeyChecked || result.RotationKeyChecked {
		t.Fatalf("unrequested checks must not be reported as verified: %+v, %v", result, err)
	}
}

func TestCheckPrivateKeyRejectsInvalidMaterialAndPins(t *testing.T) {
	content := gatewayTestKey(t)
	block, _ := pem.Decode(content)
	encrypted := pem.EncodeToMemory(&pem.Block{Type: block.Type, Bytes: block.Bytes, Headers: map[string]string{"Proc-Type": "4,ENCRYPTED"}})
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecDER, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	weak, err := rsa.GenerateKey(rand.Reader, 1024) // #nosec G403 -- negative fixture verifies weak-key rejection, never used to authenticate.
	if err != nil {
		t.Fatal(err)
	}
	for name, test := range map[string]struct {
		content            []byte
		expected, previous string
	}{
		"empty":           {},
		"oversize":        {content: bytes.Repeat([]byte("x"), MaxPrivateKeyBytes+1)},
		"malformed":       {content: []byte("not-a-key-sensitive-sentinel")},
		"invalid PKCS1":   {content: pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: []byte("invalid")})},
		"invalid PKCS8":   {content: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("invalid")})},
		"encrypted":       {content: encrypted},
		"encrypted PKCS8": {content: pem.EncodeToMemory(&pem.Block{Type: "ENCRYPTED PRIVATE KEY", Bytes: block.Bytes})},
		"EC":              {content: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER})},
		"weak RSA":        {content: pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(weak)})},
		"trailing":        {content: append(bytes.Clone(content), []byte("sensitive-trailing")...)},
		"leading":         {content: append([]byte("sensitive-leading\n"), content...)},
		"multiple":        {content: append(bytes.Clone(content), content...)},
		"malformed leading block": {
			content: append([]byte("-----BEGIN RSA PRIVATE KEY-----\ninvalid!base64\n-----END RSA PRIVATE KEY-----\n"), content...),
		},
		"unterminated leading block": {
			content: append([]byte("-----BEGIN RSA PRIVATE KEY-----\n"), content...),
		},
		"expected mismatch": {content: content, expected: strings.Repeat("0", 64)},
		"expected invalid":  {content: content, expected: "sensitive-expected"},
		"previous invalid":  {content: content, previous: "sensitive-previous"},
		"uppercase":         {content: content, expected: strings.Repeat("A", 64)},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := CheckPrivateKey(test.content, test.expected, test.previous)
			if err == nil || result != (KeyCheck{}) {
				t.Fatal("invalid material or fingerprint must fail without a success report")
			}
			if strings.Contains(err.Error(), "sensitive") || strings.Contains(err.Error(), "BEGIN") {
				t.Fatal("error disclosed input")
			}
		})
	}
}
