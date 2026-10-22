package cliegress

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsTunnelRequest(t *testing.T) {
	connect := func(mutate func(*http.Request)) *http.Request {
		r := httptest.NewRequest(http.MethodConnect, "example.com:443", nil)
		r.URL.Scheme, r.URL.Path = "", ""
		r.Host = "example.com:443"
		if mutate != nil {
			mutate(r)
		}
		return r
	}
	tests := []struct {
		name   string
		mutate func(*http.Request)
		want   bool
	}{
		{"bare connect", nil, true},
		{"get", func(r *http.Request) { r.Method = http.MethodGet }, false},
		{"host mismatch", func(r *http.Request) { r.Host = "other.example:443" }, false},
		{"path", func(r *http.Request) { r.URL.Path = "/x" }, false},
		{"query", func(r *http.Request) { r.URL.RawQuery = "a=b" }, false},
		{"scheme", func(r *http.Request) { r.URL.Scheme = "https" }, false},
		{"body", func(r *http.Request) { r.ContentLength = 1 }, false},
		{"transfer encoding", func(r *http.Request) { r.TransferEncoding = []string{"chunked"} }, false},
		{"nil url", func(r *http.Request) { r.URL = nil }, false},
	}
	for _, test := range tests {
		if got := isTunnelRequest(connect(test.mutate)); got != test.want {
			t.Errorf("%s: got %t, want %t", test.name, got, test.want)
		}
	}
}

func TestDialFirstFallsBackAndStopsOnCancellation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	good := listener.Addr().String()
	var dialed []string
	p := &proxy{dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed = append(dialed, address)
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}}
	conn, err := p.dialFirst(context.Background(), []string{"127.0.0.1:1", good, "127.0.0.1:2"})
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if len(dialed) != 2 || dialed[1] != good {
		t.Fatalf("dialed %v, want the failing candidate then %s", dialed, good)
	}

	if _, err := p.dialFirst(context.Background(), nil); err == nil {
		t.Fatal("expected an error without candidates")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dialed = nil
	if _, err := p.dialFirst(ctx, []string{"127.0.0.1:1", "127.0.0.1:2"}); err == nil {
		t.Fatal("expected an error after cancellation")
	}
	if len(dialed) != 1 {
		t.Fatalf("dialed %v, want a single attempt after cancellation", dialed)
	}
}
