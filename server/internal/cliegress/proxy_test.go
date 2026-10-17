package cliegress

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testProxy(t *testing.T) (*proxy, *httptest.Server, context.CancelFunc, *atomic.Int32) {
	t.Helper()
	policy, err := ParsePolicy([]byte(`{"hosts":["api.github.com"]}`))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	t.Cleanup(cancel)
	dials := &atomic.Int32{}
	p := &proxy{
		policy: policy, slots: make(chan struct{}, 1),
		lookup: func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("140.82.114.5")}, nil
		},
		dial: func(_ context.Context, network, address string) (net.Conn, error) {
			dials.Add(1)
			if network != "tcp" || address != "140.82.114.5:443" {
				t.Errorf("not a validated numeric dial: %s %s", network, address)
			}
			left, right := net.Pipe()
			go func() {
				defer func() { _ = right.Close() }()
				_, _ = io.Copy(right, right)
			}()
			return left, nil
		},
	}
	server := httptest.NewUnstartedServer(p)
	server.Config.BaseContext = func(net.Listener) context.Context { return ctx }
	server.Start()
	t.Cleanup(server.Close)
	return p, server, cancel, dials
}

func TestProxyRejectsNonCONNECTAndUnapprovedDestinations(t *testing.T) {
	p, _, _, dials := testProxy(t)
	for _, target := range []string{"evil.example:443", "api.github.com:80", "127.0.0.1:443", "169.254.169.254:443"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequestWithContext(t.Context(), http.MethodConnect, target, nil)
		p.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden || strings.Contains(recorder.Body.String(), target) {
			t.Fatal("denial missing or unsafe response")
		}
	}
	recorder := httptest.NewRecorder()
	p.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), "GET", "https://api.github.com/secret-token", nil))
	if recorder.Code != http.StatusForbidden || dials.Load() != 0 {
		t.Fatal("unsupported request reached an upstream")
	}
}

func TestProxyTunnelsOnlyVettedDestinationAndCancellationClosesIt(t *testing.T) {
	p, server, cancel, dials := testProxy(t)
	p.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("2606:50c0:8000::154"), netip.MustParseAddr("140.82.114.5")}, nil
	}
	dial := p.dial
	var fallbacks atomic.Int32
	p.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "[2606:50c0:8000::154]:443" {
			fallbacks.Add(1)
			return nil, errors.New("IPv6 route unavailable")
		}
		return dial(ctx, network, address)
	}
	client, err := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Close() }()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = fmt.Fprint(client, "CONNECT API.GITHUB.COM.:443 HTTP/1.1\r\nHost: API.GITHUB.COM.:443\r\nProxy-Authorization: secret-must-not-be-forwarded\r\n\r\n")
	reader := bufio.NewReader(client)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("CONNECT failed: %v %v", response, err)
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.WriteString(client, "opaque TLS payload")
	got := make([]byte, len("opaque TLS payload"))
	if _, err := io.ReadFull(reader, got); err != nil || string(got) != "opaque TLS payload" || dials.Load() != 1 || fallbacks.Load() != 1 {
		t.Fatalf("tunnel leaked headers or failed: %q %v", got, err)
	}
	// The sole connection slot is occupied until this tunnel closes.
	request := httptest.NewRequestWithContext(t.Context(), http.MethodConnect, "api.github.com:443", nil)
	recorder := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable || dials.Load() != 1 {
		t.Fatal("connection bound was bypassed")
	}
	cancel()
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("cancellation left the tunnel open")
	} else {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			t.Fatal("cancellation did not close promptly")
		}
	}
}

func TestProxyDNSFailureNeverDials(t *testing.T) {
	p, _, _, dials := testProxy(t)
	p.lookup = func(context.Context, string, string) ([]netip.Addr, error) { return nil, context.DeadlineExceeded }
	recorder := httptest.NewRecorder()
	p.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodConnect, "api.github.com:443", nil))
	if recorder.Code != http.StatusForbidden || dials.Load() != 0 {
		t.Fatal("DNS failure did not fail closed")
	}
}

func TestIdleDeadlineNeverExceedsTotalLifetime(t *testing.T) {
	deadline := time.Now().Add(time.Second)
	conn := &idleConn{deadline: deadline}
	if !conn.nextDeadline().Equal(deadline) {
		t.Fatal("idle refresh extended the total lifetime")
	}
}
