package admission

import "net/http"

// NewVerifierForTest changes only JWKS transport in test binaries. Production
// code cannot configure another issuer or trust the local simulator's key.
func NewVerifierForTest(audience string, transport http.RoundTripper) (*Verifier, error) {
	verifier, err := NewVerifier(audience)
	if err != nil {
		return nil, err
	}
	verifier.client.Transport = transport
	return verifier, nil
}
