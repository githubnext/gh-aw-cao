package server

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

func ValidateListen(address, certFile, keyFile string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("listen address must be host:port")
	}
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("non-loopback listen addresses are not supported by this local-only server")
	}
	if (certFile == "") != (keyFile == "") {
		return errors.New("TLS certificate and key must be provided together")
	}
	return nil
}

func isLoopbackListen(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())
}

func validateHostedListen(address, certFile, keyFile string) error {
	if _, _, err := net.SplitHostPort(address); err != nil {
		return errors.New("hosted listen address must be host:port")
	}
	if (certFile == "") != (keyFile == "") {
		return errors.New("hosted TLS certificate and key must be provided together")
	}
	if !isLoopbackListen(address) && certFile == "" {
		return fmt.Errorf("hosted non-loopback listener %q requires a TLS certificate and key", address)
	}
	return nil
}
