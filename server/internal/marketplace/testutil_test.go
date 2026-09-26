package marketplace

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// demoManifest is a minimal, valid aw.yml package manifest reused across tests.
const demoManifest = "name: Demo\ndescription: Example\nversion: v1\nincludes:\n  - demo.md\n"

const fakeCommitSHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// fakeGitHubConfig configures one fake GitHub REST API used by tests. It
// mirrors the shape of registryFetch() in tests/unit/activity-marketplace.test.mjs.
type fakeGitHubConfig struct {
	// manifest is served (base64-encoded) for every git/blobs request. Defaults
	// to demoManifest.
	manifest string
	// manifestPaths lists the tree entries returned for git/trees requests.
	// Defaults to a single "demo/aw.yml" entry.
	manifestPaths []string
	// failStatus, if non-zero, makes every request fail with that HTTP status.
	failStatus int
	// installationToken, if set, answers GitHub App installation token
	// exchanges instead of 404ing them.
	installationToken string
}

// fakeGitHubServer is a self-signed HTTPS test double for the GitHub REST
// endpoints Resolve/ResolveRegistry call (commits, trees, blobs, and App
// installation token exchange), recording every request for assertions.
type fakeGitHubServer struct {
	server *httptest.Server

	mu       sync.Mutex
	requests []*http.Request
}

func newFakeGitHubServer(t *testing.T, cfg fakeGitHubConfig) *fakeGitHubServer {
	t.Helper()
	manifest := cfg.manifest
	if manifest == "" {
		manifest = demoManifest
	}
	paths := cfg.manifestPaths
	if paths == nil {
		paths = []string{"demo/aw.yml"}
	}
	fake := &fakeGitHubServer{}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		fake.requests = append(fake.requests, r.Clone(r.Context()))
		fake.mu.Unlock()

		if cfg.failStatus != 0 {
			w.WriteHeader(cfg.failStatus)
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/app/installations/") && strings.HasSuffix(r.URL.Path, "/access_tokens"):
			if cfg.installationToken == "" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			writeJSON(w, map[string]any{"token": cfg.installationToken})
		case strings.Contains(r.URL.Path, "/commits/"):
			writeJSON(w, map[string]any{"sha": fakeCommitSHA})
		case strings.Contains(r.URL.Path, "/git/trees/"):
			entries := make([]map[string]any, 0, len(paths))
			for _, path := range paths {
				entries = append(entries, map[string]any{"type": "blob", "path": path, "sha": "blob-" + path})
			}
			writeJSON(w, map[string]any{"tree": entries})
		case strings.Contains(r.URL.Path, "/git/blobs/"):
			writeJSON(w, map[string]any{
				"encoding": "base64",
				"content":  base64.StdEncoding.EncodeToString([]byte(manifest)),
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func writeJSON(w http.ResponseWriter, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func (f *fakeGitHubServer) baseURL() string {
	return f.server.URL
}

func (f *fakeGitHubServer) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeGitHubServer) requestAt(index int) *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[index]
}

// insecureTestClient trusts any of the self-signed fake servers created by
// newFakeGitHubServer, so a single Options.HTTPClient can address several
// distinct fake registries within one test (each with its own base URL).
func insecureTestClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402 -- test-only transport
		},
	}
}

// fakeEnv is an in-memory environment double for EnvLookup.
type fakeEnv map[string]string

func (env fakeEnv) lookup(name string) (string, bool) {
	value, ok := env[name]
	return value, ok
}
