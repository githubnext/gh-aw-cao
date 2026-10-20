package postgresconn

import (
	"crypto/tls"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsSecureTransport(t *testing.T) {
	cases := []struct {
		name      string
		host      string
		tlsConfig *tls.Config
		want      bool
	}{
		{name: "verified tls on remote host", host: "db.example.com", tlsConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: "db.example.com"}, want: true},
		{name: "tls without hostname", host: "db.example.com", tlsConfig: &tls.Config{MinVersion: tls.VersionTLS12}, want: false},
		{name: "unix socket directory", host: "/var/run/postgresql", want: true},
		{name: "localhost literal", host: "localhost", want: true},
		{name: "localhost mixed case", host: "LocalHost", want: true},
		{name: "loopback ipv4", host: "127.0.0.1", want: true},
		{name: "loopback ipv6", host: "::1", want: true},
		{name: "remote host without tls", host: "db.example.com", want: false},
		{name: "non-loopback ip without tls", host: "10.0.0.5", want: false},
		{name: "unparseable host without tls", host: "not-an-ip", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSecureTransport(tc.host, tc.tlsConfig); got != tc.want {
				t.Fatalf("isSecureTransport(%q) = %t, want %t", tc.host, got, tc.want)
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
	config.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: "db.example.com"}
	if err := ValidateTransport(config); err != nil {
		t.Fatalf("expected a TLS-enabled remote host to pass, got %v", err)
	}
}

func TestValidateTransportSSLMode(t *testing.T) {
	for _, host := range []string{"db.example.com", "192.0.2.1", "127.0.0.1,db.example.com"} {
		for _, mode := range []string{"disable", "allow", "prefer", "require", "verify-ca", "verify-full"} {
			t.Run(host+"/"+mode, func(t *testing.T) {
				config, err := pgx.ParseConfig("host=" + host + " sslmode=" + mode)
				if err != nil {
					t.Fatal(err)
				}
				if got := ValidateTransport(config) == nil; got != (mode == "verify-full") {
					t.Fatalf("transport accepted=%t for sslmode=%s", got, mode)
				}
			})
		}
	}
}

func TestValidateTransportRejectsUnverifiedFallbackTLS(t *testing.T) {
	config, err := pgx.ParseConfig("host=127.0.0.1 sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	unverified, err := pgx.ParseConfig("host=db.example.com sslmode=require")
	if err != nil {
		t.Fatal(err)
	}
	config.Fallbacks = []*pgconn.FallbackConfig{{Host: unverified.Host, TLSConfig: unverified.TLSConfig}}
	if err := ValidateTransport(config); err == nil {
		t.Fatal("accepted remote fallback without certificate verification")
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
