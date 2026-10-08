package postgresconn

import (
	"crypto/tls"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsSecureTransport(t *testing.T) {
	cases := []struct {
		name       string
		host       string
		tlsEnabled bool
		want       bool
	}{
		{name: "tls enabled on remote host", host: "db.example.com", tlsEnabled: true, want: true},
		{name: "unix socket directory", host: "/var/run/postgresql", tlsEnabled: false, want: true},
		{name: "localhost literal", host: "localhost", tlsEnabled: false, want: true},
		{name: "localhost mixed case", host: "LocalHost", tlsEnabled: false, want: true},
		{name: "loopback ipv4", host: "127.0.0.1", tlsEnabled: false, want: true},
		{name: "loopback ipv6", host: "::1", tlsEnabled: false, want: true},
		{name: "remote host without tls", host: "db.example.com", tlsEnabled: false, want: false},
		{name: "non-loopback ip without tls", host: "10.0.0.5", tlsEnabled: false, want: false},
		{name: "unparseable host without tls", host: "not-an-ip", tlsEnabled: false, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSecureTransport(tc.host, tc.tlsEnabled); got != tc.want {
				t.Fatalf("isSecureTransport(%q, %t) = %t, want %t", tc.host, tc.tlsEnabled, got, tc.want)
			}
		})
	}
}

func TestValidateTransportRejectsNilConfig(t *testing.T) {
	if err := ValidateTransport(nil); err == nil {
		t.Fatal("expected an error for a nil config")
	}
}

func TestValidateTransportRejectsInsecurePrimaryHost(t *testing.T) {
	config := &pgx.ConnConfig{}
	config.Host = "db.example.com"
	if err := ValidateTransport(config); err == nil {
		t.Fatal("expected an error for an insecure, non-loopback primary host")
	}
}

func TestValidateTransportAcceptsLoopbackPrimaryHost(t *testing.T) {
	config := &pgx.ConnConfig{}
	config.Host = "127.0.0.1"
	if err := ValidateTransport(config); err != nil {
		t.Fatalf("expected a loopback primary host to pass, got %v", err)
	}
}

func TestValidateTransportAcceptsTLSPrimaryHost(t *testing.T) {
	config := &pgx.ConnConfig{}
	config.Host = "db.example.com"
	config.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if err := ValidateTransport(config); err != nil {
		t.Fatalf("expected a TLS-enabled remote host to pass, got %v", err)
	}
}

func TestValidateTransportRejectsInsecureFallbackHost(t *testing.T) {
	config := &pgx.ConnConfig{}
	config.Host = "127.0.0.1"
	config.Fallbacks = []*pgconn.FallbackConfig{
		{Host: "db.example.com"},
	}
	if err := ValidateTransport(config); err == nil {
		t.Fatal("expected an error for an insecure, non-loopback fallback host")
	}
}

func TestValidateTransportRejectsNilFallback(t *testing.T) {
	config := &pgx.ConnConfig{}
	config.Host = "127.0.0.1"
	config.Fallbacks = []*pgconn.FallbackConfig{nil}
	if err := ValidateTransport(config); err == nil {
		t.Fatal("expected an error for a nil fallback entry")
	}
}

func TestValidateTransportAcceptsLoopbackFallbackHost(t *testing.T) {
	config := &pgx.ConnConfig{}
	config.Host = "127.0.0.1"
	config.Fallbacks = []*pgconn.FallbackConfig{
		{Host: "::1"},
	}
	if err := ValidateTransport(config); err != nil {
		t.Fatalf("expected a loopback fallback host to pass, got %v", err)
	}
}
