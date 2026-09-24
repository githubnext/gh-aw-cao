package redisx

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"
)

func TestNewAcceptsPlaintextLoopbackURLs(t *testing.T) {
	for _, rawURL := range []string{
		"redis://localhost",
		"redis://LOCALHOST:6380/2",
		"redis://127.0.0.1:6379/0",
		"redis://127.42.0.9",
		"redis://[::1]:6379/3",
	} {
		if _, err := New(rawURL); err != nil {
			t.Errorf("New(%q) rejected loopback Redis: %v", rawURL, err)
		}
		client, err := New("redis://localhost:6380")
		if err != nil {
			t.Fatal(err)
		}
		if client.address != "127.0.0.1:6380" {
			t.Fatalf("localhost Redis would use name resolution: %q", client.address)
		}
	}
}

func TestNewRejectsRemotePlaintextURLsWithoutResolvingHostnames(t *testing.T) {
	for _, rawURL := range []string{
		"redis://example.com:6379",
		"redis://localhost.example:6379",
		"redis://192.0.2.10:6379",
		"redis://0.0.0.0:6379",
		"redis://[2001:db8::1]:6379",
	} {
		if _, err := New(rawURL); err == nil {
			t.Errorf("New(%q) accepted remote plaintext Redis", rawURL)
		}
	}
}

func TestNewAcceptsRemoteRedisOnlyWithTLS(t *testing.T) {
	client, err := New("rediss://redis.example.com:6380/4")
	if err != nil {
		t.Fatal(err)
	}
	if client.tlsConfig == nil || client.tlsConfig.ServerName != "redis.example.com" {
		t.Fatalf("remote rediss TLS configuration is invalid: %#v", client.tlsConfig)
	}
}

func TestRedisURLErrorsDoNotExposeCredentials(t *testing.T) {
	value := strings.Repeat("x", 24)
	_, err := New("redis://user:" + value + "@example.com:6379")
	if err == nil {
		t.Fatal("remote plaintext Redis URL was accepted")
	}
	if strings.Contains(err.Error(), value) {
		t.Fatal("Redis URL error exposed credentials")
	}
}

func TestClientReusesConnectionsForConcurrentSafePooling(t *testing.T) {
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	accepted := make(chan int, 1)
	serverErr := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer func() { _ = connection.Close() }()
		accepted <- 1
		reader := bufio.NewReader(connection)
		for range 2 {
			if _, err := readRESP(reader); err != nil {
				serverErr <- err
				return
			}
			if _, err := fmt.Fprint(connection, "+PONG\r\n"); err != nil {
				serverErr <- err
				return
			}
		}
		serverErr <- nil
	}()
	client, err := New("redis://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := client.Do(t.Context(), "PING"); err != nil {
			t.Fatal(err)
		}
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
	if count := <-accepted; count != 1 {
		t.Fatalf("accepted %d connections, want one reused connection", count)
	}
}

func TestRedissUsesVerifiedTLSAndPreservesAuthenticationAndDatabase(t *testing.T) {
	certificate, roots := testRedisCertificate(t)
	address, commands, serverErr := startTLSRedis(t, certificate, 3)

	client, err := New("rediss://alice:secret@" + address + "/3")
	if err != nil {
		t.Fatal(err)
	}
	if client.tlsConfig == nil {
		t.Fatal("rediss did not configure TLS")
	}
	if client.tlsConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("TLS minimum version = %x, want TLS 1.2", client.tlsConfig.MinVersion)
	}
	if client.tlsConfig.ServerName != "127.0.0.1" {
		t.Fatalf("TLS server name = %q, want 127.0.0.1", client.tlsConfig.ServerName)
	}
	if client.tlsConfig.InsecureSkipVerify {
		t.Fatal("TLS certificate verification is disabled")
	}
	client.tlsConfig.RootCAs = roots

	value, err := client.Do(t.Context(), "PING")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(value) != "PONG" {
		t.Fatalf("PING returned %v", value)
	}
	expected := [][]string{
		{"AUTH", "alice", "secret"},
		{"SELECT", "3"},
		{"PING"},
	}
	for i := range expected {
		command := <-commands
		if !equalStrings(command, expected[i]) {
			t.Fatalf("command %d did not preserve Redis URL behavior", i)
		}
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

func TestRedissRejectsHostnameMismatch(t *testing.T) {
	certificate, roots := testRedisCertificate(t)
	address, _, serverErr := startTLSRedis(t, certificate, 0)

	client, err := New("rediss://" + address)
	if err != nil {
		t.Fatal(err)
	}
	client.tlsConfig.RootCAs = roots
	client.tlsConfig.ServerName = "wrong.example"
	if _, err := client.Do(t.Context(), "PING"); err == nil {
		t.Fatal("rediss accepted a certificate for the wrong hostname")
	}
	if err := <-serverErr; err == nil {
		t.Fatal("TLS server unexpectedly completed a mismatched handshake")
	}
}

func startTLSRedis(t *testing.T, certificate tls.Certificate, commandCount int) (string, <-chan []string, <-chan error) {
	t.Helper()
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsListener := tls.NewListener(listener, &tls.Config{
		Certificates: []tls.Certificate{certificate},
		MinVersion:   tls.VersionTLS12,
	})
	t.Cleanup(func() {
		_ = tlsListener.Close()
	})
	commands := make(chan []string, commandCount)
	serverErr := make(chan error, 1)
	go func() {
		connection, acceptErr := tlsListener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer func() {
			_ = connection.Close()
		}()
		reader := bufio.NewReader(connection)
		for range commandCount {
			value, readErr := readRESP(reader)
			if readErr != nil {
				serverErr <- readErr
				return
			}
			command, stringsErr := Strings(value)
			if stringsErr != nil {
				serverErr <- stringsErr
				return
			}
			commands <- command
			response := "+OK\r\n"
			if len(command) == 1 && command[0] == "PING" {
				response = "+PONG\r\n"
			}
			if _, writeErr := fmt.Fprint(connection, response); writeErr != nil {
				serverErr <- writeErr
				return
			}
		}
		if commandCount == 0 {
			serverErr <- connection.(*tls.Conn).HandshakeContext(t.Context())
			return
		}
		serverErr <- nil
	}()
	return listener.Addr().String(), commands, serverErr
}

func testRedisCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Redis test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	leafKeyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	certificatePEM = append(certificatePEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	certificate, err := tls.X509KeyPair(
		certificatePEM,
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: leafKeyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	return certificate, roots
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
