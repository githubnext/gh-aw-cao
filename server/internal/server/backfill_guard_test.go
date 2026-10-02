package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

func TestSyntheticGitHubClientCannotFallBackToLiveAPI(t *testing.T) {
	var calls atomic.Int64
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	}))
	defer local.Close()
	transport, err := simulator.NewLocalTransport(local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	key, err := stressAppKey()
	if err != nil {
		t.Fatal(err)
	}
	client, err := githubapp.New(githubapp.Config{
		AppID: 1, PrivateKeyPEM: key, Transport: transport,
		// Deliberately omit BaseURL to exercise go-github's live default.
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListInstallations(t.Context()); err == nil || !strings.Contains(err.Error(), "allowlisted endpoint") {
		t.Fatalf("live GitHub fallback was not blocked before dialing: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("blocked fallback contacted an endpoint")
	}
}
