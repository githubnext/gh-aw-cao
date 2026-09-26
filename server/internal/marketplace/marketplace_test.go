package marketplace

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestParseConfigReadsMarketplaceSectionWithOrderPreserved(t *testing.T) {
	data := []byte(`{
		"version": 1,
		"control-plane": {
			"marketplace": {
				"cache-ttl-seconds": 120,
				"registries": [
					{"id": "official", "repository": "example/packages", "ref": "main"},
					{"id": "third-party", "repository": "third/packages", "ref": "main"}
				]
			}
		}
	}`)
	config, err := ParseConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if config.CacheTTL.Seconds() != 120 {
		t.Fatalf("unexpected cache TTL: %v", config.CacheTTL)
	}
	if len(config.Registries) != 2 || config.Registries[0].ID != "official" || config.Registries[1].ID != "third-party" {
		t.Fatalf("registries were not preserved in order: %#v", config.Registries)
	}
}

func TestParseConfigWithoutMarketplaceSectionIsEmptyNotAnError(t *testing.T) {
	config, err := ParseConfig([]byte(`{"version":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(config.Registries) != 0 {
		t.Fatalf("expected no registries, got: %#v", config.Registries)
	}
}

func TestParseConfigRejectsOversizedPolicy(t *testing.T) {
	oversized := append([]byte(`{"padding":"`), make([]byte, maxPolicyBytes+1)...)
	oversized = append(oversized, []byte(`"}`)...)
	if _, err := ParseConfig(oversized); err == nil {
		t.Fatal("expected an oversized policy document to be rejected")
	}
}

func TestValidateRegistryNormalizesPathAndDefaultsName(t *testing.T) {
	registry, err := ValidateRegistry(Registry{ID: "official", Repository: "example/packages", Ref: "main", Path: "/packages/"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if registry.Path != "packages" {
		t.Fatalf("expected trimmed path, got: %q", registry.Path)
	}
	if registry.Name != "official" {
		t.Fatalf("expected name to default to id, got: %q", registry.Name)
	}
}

func TestValidateRegistryRejectsInvalidShapes(t *testing.T) {
	cases := []struct {
		name     string
		registry Registry
	}{
		{"bad id", Registry{ID: "Official!", Repository: "example/packages", Ref: "main"}},
		{"bad repository", Registry{ID: "official", Repository: "not-a-repo", Ref: "main"}},
		{"missing ref", Registry{ID: "official", Repository: "example/packages", Ref: " "}},
		{"path traversal", Registry{ID: "official", Repository: "example/packages", Ref: "main", Path: "../secrets"}},
		{"absolute path", Registry{ID: "official", Repository: "example/packages", Ref: "main", Path: "/etc/passwd"}},
		{"nested path traversal", Registry{ID: "official", Repository: "example/packages", Ref: "main", Path: "packages/../../etc"}},
		{"non-https api-url", Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: "http://github.example/api/v3"}},
		{
			"invalid pat secret name",
			Registry{
				ID: "official", Repository: "example/packages", Ref: "main",
				Auth: Auth{Type: AuthPAT, Secret: "literal-token"},
			},
		},
		{
			"invalid github-app secret name",
			Registry{
				ID: "official", Repository: "example/packages", Ref: "main",
				Auth: Auth{
					Type: AuthGitHubApp, AppIDSecret: "APP_ID",
					PrivateKeySecret: "not-an-env-name", InstallationIDSecret: "INSTALLATION_ID",
				},
			},
		},
		{
			"unsupported auth type",
			Registry{ID: "official", Repository: "example/packages", Ref: "main", Auth: Auth{Type: "oauth"}},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := ValidateRegistry(testCase.registry, 0); err == nil {
				t.Fatalf("expected registry to be rejected: %#v", testCase.registry)
			}
		})
	}
}

func TestValidateRegistryAcceptsDotSegmentsThatAreNotTraversal(t *testing.T) {
	// ".config" is a valid directory name; only an exact ".." segment must be rejected.
	registry, err := ValidateRegistry(Registry{ID: "official", Repository: "example/packages", Ref: "main", Path: ".config/packages"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if registry.Path != ".config/packages" {
		t.Fatalf("unexpected normalized path: %q", registry.Path)
	}
}

func TestResolveIsolatesRegistryFailuresAndKeepsHealthyPackages(t *testing.T) {
	healthy := newFakeGitHubServer(t, fakeGitHubConfig{})
	failing := newFakeGitHubServer(t, fakeGitHubConfig{failStatus: 503})

	config := &Config{Registries: []Registry{
		{ID: "unavailable", Repository: "example/packages", Ref: "main", APIURL: failing.baseURL()},
		{ID: "third-party", Repository: "example/packages", Ref: "main", APIURL: healthy.baseURL()},
	}}

	result := Resolve(t.Context(), config, "generation-1", nil, Options{HTTPClient: insecureTestClient()})

	if len(result.Packages) != 1 || result.Packages[0].RegistryID != "third-party" {
		t.Fatalf("expected only the healthy registry's package, got: %#v", result.Packages)
	}
	if len(result.Diagnostics) != 2 || result.Diagnostics[0].Status != "unavailable" || result.Diagnostics[1].Status != "available" {
		t.Fatalf("unexpected diagnostics: %#v", result.Diagnostics)
	}
	if result.Diagnostics[1].Packages != 1 {
		t.Fatalf("expected the healthy registry diagnostic to report 1 package, got: %#v", result.Diagnostics[1])
	}
}

func TestResolveKeepsEarliestDuplicatePackageByPrecedence(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{})
	config := &Config{Registries: []Registry{
		{ID: "first", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()},
		{ID: "second", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()},
	}}

	result := Resolve(t.Context(), config, "generation-1", nil, Options{HTTPClient: insecureTestClient()})

	if len(result.Packages) != 1 || result.Packages[0].RegistryID != "first" {
		t.Fatalf("expected the earliest registry's package to win, got: %#v", result.Packages)
	}
}

func TestResolveWithNilConfigReturnsEmptyResultNotNil(t *testing.T) {
	result := Resolve(t.Context(), nil, "generation-1", nil, Options{})
	if result == nil || result.Packages == nil || result.Diagnostics == nil {
		t.Fatalf("expected non-nil empty slices, got: %#v", result)
	}
}

// errFakeTransport lets a test simulate a transport failure whose message
// happens to contain a secret value, exercising diagnostic redaction.
type errFakeTransport string

func (e errFakeTransport) Error() string { return string(e) }

func TestResolveRedactsReferencedSecretValuesFromDiagnosticMessages(t *testing.T) {
	// A registry with no api-url still tries to reach api.github.com; use an
	// HTTP client whose transport always fails with a message that happens to
	// contain the (fake) secret value, as a hostile or misconfigured upstream
	// could otherwise leak it back into diagnostics.
	config := &Config{Registries: []Registry{
		{
			ID: "private", Repository: "example/packages", Ref: "main",
			Auth: Auth{Type: AuthPAT, Secret: "PRIVATE_REGISTRY_TOKEN"},
		},
	}}
	opts := Options{
		HTTPClient: failingDoer{err: errFakeTransport("request rejected for not-client-data")},
		Env:        fakeEnv{"PRIVATE_REGISTRY_TOKEN": "not-client-data"}.lookup,
	}
	result := Resolve(t.Context(), config, "generation-1", nil, opts)

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "not-client-data") {
		t.Fatalf("diagnostic leaked a secret value: %s", encoded)
	}
	if !strings.Contains(result.Diagnostics[0].Message, "[redacted]") {
		t.Fatalf("expected the diagnostic message to redact the secret value, got: %q", result.Diagnostics[0].Message)
	}
}

// failingDoer is an HTTPDoer that always fails with err.
type failingDoer struct{ err error }

func (d failingDoer) Do(*http.Request) (*http.Response, error) { return nil, d.err }

func TestResolveNeverSerializesSecretValuesOrTokens(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{})
	config := &Config{Registries: []Registry{
		{
			ID: "private", Repository: "example/packages", Ref: "main", APIURL: server.baseURL(),
			Auth: Auth{Type: AuthPAT, Secret: "PRIVATE_REGISTRY_TOKEN"},
		},
	}}
	opts := Options{
		HTTPClient: insecureTestClient(),
		Env:        fakeEnv{"PRIVATE_REGISTRY_TOKEN": "not-client-data"}.lookup,
	}
	result := Resolve(t.Context(), config, "generation-1", nil, opts)

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if matched, _ := regexp.MatchString(`not-client-data|PRIVATE_REGISTRY_TOKEN|Authorization`, string(encoded)); matched {
		t.Fatalf("result leaked secret material: %s", encoded)
	}
	if len(result.Packages) != 1 {
		t.Fatalf("expected the private registry package to resolve, got: %#v", result.Packages)
	}
	// The captured *outbound* request to the fake GitHub server should still
	// carry the real token (that is how GitHub authenticates it) — only the
	// *result* returned to dashboard clients must never contain it.
	requestAuth := server.requestAt(server.requestCount() - 1).Header.Get("Authorization")
	if requestAuth != "Bearer not-client-data" {
		t.Fatalf("expected the PAT to reach GitHub as a bearer token, got: %q", requestAuth)
	}
}
