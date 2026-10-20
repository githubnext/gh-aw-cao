// Package postgresconn owns transport validation shared by PostgreSQL adapters.
package postgresconn

import (
	"crypto/tls"
	"errors"
	"net/netip"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-cao/server/internal/logger"
)

var transportLog = logger.New("cao:postgresconn")

// transportRejectionStage identifies which connection endpoint failed
// ValidateTransport's verified-TLS-or-loopback precondition, so a misconfigured
// Postgres endpoint is diagnosable without logging the host itself, which
// can reveal internal network topology.
type transportRejectionStage string

const (
	transportRejectionStagePrimary  transportRejectionStage = "primary-host"
	transportRejectionStageFallback transportRejectionStage = "fallback-host"
)

// Remote connections require both chain and hostname verification. Encryption
// alone (pgx sslmode=require or verify-ca) does not authenticate the database.
func isSecureTransport(host string, config *tls.Config) bool {
	if filepath.IsAbs(host) || strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(host)
	if err == nil && address.IsLoopback() {
		return true
	}
	return config != nil && !config.InsecureSkipVerify && config.ServerName != ""
}

// ValidateTransport requires every PostgreSQL adapter connection to use verified TLS
// unless it targets a Unix socket or a loopback address, rejecting a plain
// connection to any other host before it is used.
func ValidateTransport(config *pgx.ConnConfig) error {
	if config == nil {
		return errors.New("postgres connection configuration is required")
	}
	if !isSecureTransport(config.Host, config.TLSConfig) {
		transportLog.Printf("postgres transport rejected stage=%s", transportRejectionStagePrimary)
		return errors.New("postgres verified TLS with hostname verification (sslmode=verify-full) is required for non-loopback connections")
	}
	for _, fallback := range config.Fallbacks {
		if fallback == nil || !isSecureTransport(fallback.Host, fallback.TLSConfig) {
			transportLog.Printf("postgres transport rejected stage=%s", transportRejectionStageFallback)
			return errors.New("postgres verified TLS with hostname verification (sslmode=verify-full) is required for non-loopback fallback connections")
		}
	}
	return nil
}
