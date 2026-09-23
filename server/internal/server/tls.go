package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"time"
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

func LoadOrGenerateCertificate(certFile, keyFile string) (certificatePEM, keyPEM []byte, generated bool, err error) {
	if certFile != "" {
		// #nosec G304 -- the operator explicitly configures the local certificate path.
		certificatePEM, err = os.ReadFile(certFile)
		if err != nil {
			return nil, nil, false, err
		}
		// #nosec G304 -- the operator explicitly configures the local private-key path.
		keyPEM, err = os.ReadFile(keyFile)
		return certificatePEM, keyPEM, false, err
	}
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, false, err
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return nil, nil, false, err
	}
	now := time.Now()
	template := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return nil, nil, false, err
	}
	key, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, nil, false, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), true, nil
}
