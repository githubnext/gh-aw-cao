package server

import (
	"errors"
	"net"
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
