package simulator

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
)

// LocalTransport cannot follow redirects or proxy settings out of the exact
// numeric-loopback simulator endpoint. Hostnames are deliberately not resolved.
type LocalTransport struct {
	target    *url.URL
	transport *http.Transport
}

func NewLocalTransport(endpoint string) (*LocalTransport, error) {
	target, err := url.Parse(endpoint)
	if err != nil || target.Scheme != "http" || target.User != nil || target.RawQuery != "" ||
		target.Fragment != "" || target.Port() == "" || !net.ParseIP(target.Hostname()).IsLoopback() {
		return nil, errors.New("simulation requires an explicit numeric-loopback HTTP endpoint")
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != target.Host {
				return nil, errors.New("simulation blocked a connection outside its allowlisted endpoint")
			}
			return (&net.Dialer{}).DialContext(ctx, network, address)
		},
	}
	return &LocalTransport{target: target, transport: transport}, nil
}

func (t *LocalTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme != t.target.Scheme || request.URL.Host != t.target.Host ||
		request.URL.User != nil {
		return nil, errors.New("simulation blocked a request outside its allowlisted endpoint")
	}
	return t.transport.RoundTrip(request)
}

func (t *LocalTransport) CloseIdleConnections() { t.transport.CloseIdleConnections() }
