// Package postgresconn owns transport validation shared by PostgreSQL adapters.
package postgresconn

import (
	"errors"
	"net/netip"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var transportLog = logger.New("cao:postgresconn")

// transportRejectionStage identifies which connection endpoint failed
// ValidateTransport's TLS-or-loopback precondition, so a misconfigured
// Postgres endpoint is diagnosable without logging the host itself, which
// can reveal internal network topology.
type transportRejectionStage string

const (
	transportRejectionStagePrimary  transportRejectionStage = "primary-host"
	transportRejectionStageFallback transportRejectionStage = "fallback-host"
)

// isSecureTransport reports whether host is safe to connect to without TLS:
// TLS is already enabled, host is a Unix socket directory (an absolute
// path), host is the literal name "localhost", or host parses as a loopback
// IP address. It is a pure function extracted from ValidateTransport's
// inline closure so the TLS-or-loopback decision is independently testable
// against host strings, without constructing a pgx.ConnConfig.
func isSecureTransport(host string, tlsEnabled bool) bool {
	if tlsEnabled || filepath.IsAbs(host) || strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

// ValidateTransport requires every PostgreSQL adapter connection to use TLS
// unless it targets a Unix socket or a loopback address, rejecting a plain
// connection to any other host before it is used.
func ValidateTransport(config *pgx.ConnConfig) error {
	if config == nil {
		return errors.New("postgres connection configuration is required")
	}
	if !isSecureTransport(config.Host, config.TLSConfig != nil) {
		transportLog.Printf("postgres transport rejected stage=%s", transportRejectionStagePrimary)
		return errors.New("postgres TLS is required for non-loopback connections")
	}
	for _, fallback := range config.Fallbacks {
		if fallback == nil || !isSecureTransport(fallback.Host, fallback.TLSConfig != nil) {
			transportLog.Printf("postgres transport rejected stage=%s", transportRejectionStageFallback)
			return errors.New("postgres TLS is required for non-loopback fallback connections")
		}
	}
	return nil
}
