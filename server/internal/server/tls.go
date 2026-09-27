package server

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// normalizeListenHost extracts and normalizes the host portion of a
// host:port listen address, stripping the brackets net.SplitHostPort leaves
// around a bracketed IPv6 literal. It is the single place both loopback
// classifiers below parse a listen address, so they can never disagree about
// what "the host" of an address is.
func normalizeListenHost(address string) (host string, ok bool) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return "", false
	}
	return strings.Trim(host, "[]"), true
}

func ValidateListen(address, certFile, keyFile string) error {
	host, ok := normalizeListenHost(address)
	if !ok {
		return errors.New("listen address must be host:port")
	}
	if !isLoopbackHost(host) {
		return errors.New("non-loopback listen addresses are not supported by this local-only server")
	}
	if (certFile == "") != (keyFile == "") {
		return errors.New("TLS certificate and key must be provided together")
	}
	return nil
}

func isLoopbackListen(address string) bool {
	host, ok := normalizeListenHost(address)
	return ok && isLoopbackHost(host)
}

func validateHostedListen(address, certFile, keyFile string, trustForwarded bool) error {
	host, ok := normalizeListenHost(address)
	if !ok {
		return errors.New("hosted listen address must be host:port")
	}
	if (certFile == "") != (keyFile == "") {
		return errors.New("hosted TLS certificate and key must be provided together")
	}
	loopback := isLoopbackHost(host)
	tlsConfigured := certFile != ""
	// This is the boundary that decides whether a hosted listener may serve
	// plaintext: logging the three inputs to that decision (never the
	// address itself) makes a misconfigured deployment diagnosable without
	// exposing where it listens.
	serverLog.Printf("hosted listener validated loopback=%t tls=%t trust_forwarded=%t", loopback, tlsConfigured, trustForwarded)
	if !loopback && !tlsConfigured && !trustForwarded {
		return fmt.Errorf("hosted non-loopback listener %q requires a TLS certificate and key", address)
	}
	return nil
}
