package server

import "testing"

func TestNormalizeListenHostStripsIPv6Brackets(t *testing.T) {
	tests := []struct {
		address  string
		wantHost string
		wantOK   bool
	}{
		{address: "127.0.0.1:8443", wantHost: "127.0.0.1", wantOK: true},
		{address: "[::1]:8443", wantHost: "::1", wantOK: true},
		{address: "localhost:8443", wantHost: "localhost", wantOK: true},
		{address: "not-a-host-port", wantHost: "", wantOK: false},
	}
	for _, test := range tests {
		host, ok := normalizeListenHost(test.address)
		if ok != test.wantOK || host != test.wantHost {
			t.Errorf("normalizeListenHost(%q) = (%q, %t), want (%q, %t)",
				test.address, host, ok, test.wantHost, test.wantOK)
		}
	}
}

// TestIsLoopbackListenAgreesWithValidateListen guards against the two
// loopback classifiers (ValidateListen's inline check and isLoopbackListen)
// disagreeing now that both parse addresses through the shared
// normalizeListenHost helper.
func TestIsLoopbackListenAgreesWithValidateListen(t *testing.T) {
	loopback := []string{"127.0.0.1:8443", "localhost:8443", "[::1]:8443"}
	nonLoopback := []string{"0.0.0.0:8443", "203.0.113.10:8443"}
	for _, address := range loopback {
		if !isLoopbackListen(address) {
			t.Errorf("isLoopbackListen(%q) = false, want true", address)
		}
		if err := ValidateListen(address, "", ""); err != nil {
			t.Errorf("ValidateListen(%q) rejected a loopback address: %v", address, err)
		}
	}
	for _, address := range nonLoopback {
		if isLoopbackListen(address) {
			t.Errorf("isLoopbackListen(%q) = true, want false", address)
		}
		if err := ValidateListen(address, "", ""); err == nil {
			t.Errorf("ValidateListen(%q) accepted a non-loopback address", address)
		}
	}
}

func TestValidateHostedListenRejectsMalformedAddress(t *testing.T) {
	if err := validateHostedListen("not-a-host-port", "", "", false); err == nil {
		t.Fatal("expected malformed hosted listen address to be rejected")
	}
}
