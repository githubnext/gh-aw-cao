// Package postgresconn owns transport validation shared by PostgreSQL adapters.
package postgresconn

import (
	"errors"
	"net/netip"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
)

func ValidateTransport(config *pgx.ConnConfig) error {
	if config == nil {
		return errors.New("postgres connection configuration is required")
	}
	secure := func(host string, tlsEnabled bool) bool {
		if tlsEnabled || filepath.IsAbs(host) || strings.EqualFold(host, "localhost") {
			return true
		}
		address, err := netip.ParseAddr(host)
		return err == nil && address.IsLoopback()
	}
	if !secure(config.Host, config.TLSConfig != nil) {
		return errors.New("postgres TLS is required for non-loopback connections")
	}
	for _, fallback := range config.Fallbacks {
		if fallback == nil || !secure(fallback.Host, fallback.TLSConfig != nil) {
			return errors.New("postgres TLS is required for non-loopback fallback connections")
		}
	}
	return nil
}
