package server

import (
	"crypto/tls"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

func TestHostedProxyTrust(t *testing.T) {
	for _, tc := range []struct {
		name, listen, certificate string
		configured                []netip.Prefix
		wantForwarded             bool
		wantPrefixes              int
	}{
		{name: "loopback proxy", listen: "127.0.0.1:8080", wantForwarded: true, wantPrefixes: 2},
		{name: "direct loopback TLS", listen: "127.0.0.1:8443", certificate: "server.pem"},
		{name: "direct public TLS", listen: "0.0.0.0:8443", certificate: "server.pem"},
		{name: "explicit proxy with TLS", listen: "127.0.0.1:8443", certificate: "server.pem", configured: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}, wantForwarded: true, wantPrefixes: 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			forwarded, prefixes := hostedProxyTrust(tc.listen, tc.certificate, tc.configured)
			if forwarded != tc.wantForwarded || len(prefixes) != tc.wantPrefixes {
				t.Fatalf("forwarded=%t prefixes=%d, want %t and %d", forwarded, len(prefixes), tc.wantForwarded, tc.wantPrefixes)
			}
			store, err := memory.New(memory.Config{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			policy := ProxyPolicy{
				AllowedHosts: []string{"dashboard.example"}, RequireHTTPS: true,
				TrustForwarded: forwarded, TrustedProxyPrefixes: prefixes,
			}
			config := Config{
				HostProfile: HostProfile{
					Name: "hosted", Authentication: HostAuthenticationOAuth,
					Listener: HostListenerProcess, RequiresHTTPS: true,
				},
				Listen: tc.listen, CertFile: tc.certificate, Proxy: policy,
				GitHubOAuth: &GitHubOAuthConfig{
					ClientID: "fixture", ClientSecret: "fixture",
					RedirectURL:   "https://dashboard.example/auth/callback",
					SessionSecret: strings.Repeat("s", 32), AllowedOrganizations: []string{"fixture"},
				},
			}
			if tc.certificate != "" {
				config.KeyFile = "server.key"
			}
			if err := validateHostedMode(store, &config); err != nil {
				t.Fatal(err)
			}
			if config.Proxy.TrustForwarded != tc.wantForwarded {
				t.Fatal("hosted validation changed the selected direct TLS/proxy mode")
			}
			request := httptest.NewRequestWithContext(t.Context(), "GET", "https://dashboard.example/api/readiness", nil)
			request.TLS = &tls.ConnectionState{}
			request.RemoteAddr = "127.0.0.1:12345"
			if forwarded {
				request.Header.Set("X-Forwarded-Proto", "https")
			}
			if rejection := classifyProxyRequest(request, policy); rejection != proxyRejectionNone {
				t.Fatalf("valid TLS/proxy request rejected: %s", rejection)
			}
			request.Host = "attacker.example"
			if rejection := classifyProxyRequest(request, policy); rejection != proxyRejectionHostNotAllowed {
				t.Fatalf("unexpected host rejection: %s", rejection)
			}
			request.Host = "dashboard.example"
			if forwarded {
				request.RemoteAddr = "203.0.113.1:12345"
				if rejection := classifyProxyRequest(request, policy); rejection != proxyRejectionUntrustedPeer {
					t.Fatalf("unexpected peer rejection: %s", rejection)
				}
			} else {
				request.TLS = nil
				request.Header.Set("X-Forwarded-Proto", "https")
				if rejection := classifyProxyRequest(request, policy); rejection != proxyRejectionInsecureRequest {
					t.Fatalf("forged forwarded scheme authorized plaintext: %s", rejection)
				}
			}
		})
	}
}
