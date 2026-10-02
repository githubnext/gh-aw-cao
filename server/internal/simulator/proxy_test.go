package simulator

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestFaultProxyInjectsBoundedFaultsThenRecovers(t *testing.T) {
	var upstream atomic.Int64
	origin := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		upstream.Add(1)
		writer.WriteHeader(http.StatusOK)
	}))
	defer origin.Close()
	proxy, err := NewFaultProxy(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	if err := proxy.Inject(APIFault{Path: "/runs", Page: 2, Count: 2, Mode: "service-unavailable"}); err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(proxy)
	defer local.Close()
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusServiceUnavailable, http.StatusOK} {
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, local.URL+"/runs?page=2", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := local.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("proxy returned %d, want %d", response.StatusCode, status)
		}
	}
	if upstream.Load() != 1 || proxy.RequestCount("/runs", 2) != 3 {
		t.Fatal("faults reached the upstream or did not expire at the configured count")
	}
}

func TestFaultProxyRejectsInvalidFaults(t *testing.T) {
	for _, fault := range []APIFault{
		{Path: "https://api.github.com", Mode: "internal-error", Count: 1},
		{Path: "/x?secret=x", Mode: "internal-error", Count: 1},
		{Path: "/x", Mode: "unknown", Count: 1},
		{Path: "/x", Mode: "timeout", Count: 0},
		{Path: "/x", Mode: "primary-rate-limit", Count: 1, ResetAt: "invalid"},
	} {
		if err := fault.Validate(); err == nil {
			t.Fatal("accepted an invalid simulator fault")
		}
	}
}
