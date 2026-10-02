package simulator

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestLocalTransportRejectsLiveAndAmbiguousEndpoints(t *testing.T) {
	for _, endpoint := range []string{
		"", "https://api.github.com", "http://api.github.com:80", "http://localhost:8080",
		"http://169.254.169.254:80", "http://127.0.0.1", "http://user:secret@127.0.0.1:8080",
		"http://127.0.0.1:8080/?token=secret", "http://127.0.0.1:8080/#fragment",
	} {
		if transport, err := NewLocalTransport(endpoint); err == nil {
			transport.CloseIdleConnections()
			t.Fatalf("simulation accepted an unguarded endpoint: %s", endpoint)
		}
	}
}

func TestLocalTransportBlocksRedirectsAndIgnoresEnvironmentProxies(t *testing.T) {
	var escaped atomic.Int64
	trap := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		escaped.Add(1)
		writer.WriteHeader(http.StatusOK)
	}))
	defer trap.Close()
	t.Setenv("HTTP_PROXY", trap.URL)
	t.Setenv("HTTPS_PROXY", trap.URL)
	t.Setenv("ALL_PROXY", trap.URL)
	t.Setenv("NO_PROXY", "")
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect" {
			http.Redirect(writer, request, trap.URL, http.StatusFound)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer local.Close()
	transport, err := NewLocalTransport(local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, local.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("environment proxy intercepted local simulation")
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	request, err = http.NewRequestWithContext(t.Context(), http.MethodGet, local.URL+"/redirect", nil)
	if err != nil {
		t.Fatal(err)
	}
	if response, err := client.Do(request); err == nil {
		_ = response.Body.Close()
		t.Fatal("simulation followed a redirect outside its exact endpoint")
	}
	if escaped.Load() != 0 {
		t.Fatal("a redirect or environment proxy escaped the local endpoint")
	}
}
