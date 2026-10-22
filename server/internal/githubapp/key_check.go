package githubapp

import (
	"bytes"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
)

// MaxPrivateKeyBytes bounds the offline key diagnostic, not runtime signing.
const MaxPrivateKeyBytes = 64 << 10

// KeyCheck contains only public metadata. It does not establish GitHub
// registration, remote key revocation, or the key loaded by a running process.
type KeyCheck struct {
	Algorithm          string `json:"algorithm"`
	Bits               int    `json:"bits"`
	PublicKeySHA256    string `json:"publicKeySHA256"`
	ExpectedKeyChecked bool   `json:"expectedKeyChecked"`
	RotationKeyChecked bool   `json:"rotationKeyChecked"`
	Scope              string `json:"scope"`
}

// CheckPrivateKey validates one unencrypted RSA PEM and optionally pins its
// public identity and checks that a rollover changes the public key.
func CheckPrivateKey(content []byte, expected, previous string) (KeyCheck, error) {
	if len(content) == 0 || len(content) > MaxPrivateKeyBytes {
		return KeyCheck{}, errors.New("app key check requires a nonempty PEM of at most 64 KiB")
	}
	if (expected != "" && !validPublicKeySHA256(expected)) || (previous != "" && !validPublicKeySHA256(previous)) {
		return KeyCheck{}, errors.New("app key fingerprints must be lowercase SHA-256 hex of DER SubjectPublicKeyInfo")
	}
	content = bytes.TrimSpace(content)
	block, rest := pem.Decode(content)
	if block == nil || len(bytes.TrimSpace(rest)) != 0 || len(block.Headers) != 0 ||
		!bytes.HasPrefix(content, []byte("-----BEGIN "+block.Type+"-----")) {
		return KeyCheck{}, errors.New("app key check requires exactly one unencrypted private-key PEM block")
	}
	var key *rsa.PrivateKey
	switch block.Type {
	case "RSA PRIVATE KEY":
		parsed, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return KeyCheck{}, errors.New("app key RSA private key is invalid")
		}
		key = parsed
	case "PRIVATE KEY":
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return KeyCheck{}, errors.New("app key PKCS#8 private key is invalid")
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return KeyCheck{}, errors.New("app key check requires RSA for GitHub RS256 signing")
		}
	default:
		return KeyCheck{}, errors.New("app key check requires an RSA PKCS#1 or PKCS#8 private key")
	}
	if key.N.BitLen() < 2048 || key.N.BitLen() > 8192 {
		return KeyCheck{}, errors.New("app key diagnostic requires RSA keys between 2048 and 8192 bits")
	}
	if err := key.Validate(); err != nil {
		return KeyCheck{}, errors.New("app key RSA consistency validation failed")
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return KeyCheck{}, errors.New("app key public identity is unavailable")
	}
	digest := sha256.Sum256(publicDER)
	fingerprint := hex.EncodeToString(digest[:])
	if expected != "" && fingerprint != expected {
		return KeyCheck{}, errors.New("app key does not match the expected public-key fingerprint")
	}
	if previous != "" && fingerprint == previous {
		return KeyCheck{}, errors.New("app key rollover requires a different public key")
	}
	return KeyCheck{
		Algorithm: "RS256", Bits: key.N.BitLen(), PublicKeySHA256: fingerprint,
		ExpectedKeyChecked: expected != "", RotationKeyChecked: previous != "", Scope: "offline-key-material-only",
	}, nil
}

func validPublicKeySHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}
