package marketplace

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

var excludedPackageFields = []string{
	"verification-status", "verification-source", "maintenance-status", "maintenance-source",
	"last-maintained-at", "popularity-source", "signals-observed-at",
	"installation-status", "adoption-count", "adoption-source",
}

func TestRegistryRepositoryCountsAndPackageFields(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{
		manifestPaths:     []string{"one/aw.yml", "two/aw.yml"},
		manifest:          "name: Demo\n",
		repositoryPayload: map[string]any{"private": false, "visibility": "public", "stargazers_count": 0, "forks_count": 12},
	})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}
	packages, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()})
	if err != nil || len(packages) != 2 {
		t.Fatalf("resolve registry: %+v, %v", packages, err)
	}
	repoCalls := 0
	for i := 0; i < server.requestCount(); i++ {
		if server.requestAt(i).URL.Path == "/repos/example/packages" {
			repoCalls++
			if server.requestAt(i).Method != http.MethodGet {
				t.Fatal("repository counts request must be GET")
			}
		}
	}
	if repoCalls != 1 {
		t.Fatalf("wanted one repository lookup per registry, got %d", repoCalls)
	}
	for _, pkg := range packages {
		if pkg.Stars == nil || *pkg.Stars != 0 || pkg.Forks == nil || *pkg.Forks != 12 {
			t.Fatalf("unexpected repository counts: %+v", pkg)
		}
		var dto map[string]any
		data, err := json.Marshal(pkg)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &dto); err != nil {
			t.Fatal(err)
		}
		var row map[string]any
		rowData, err := json.Marshal(pkg.Row())
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(rowData, &row); err != nil {
			t.Fatal(err)
		}
		for _, field := range excludedPackageFields {
			if _, exists := dto[field]; exists {
				t.Errorf("DTO exposes removed field %s", field)
			}
			if _, exists := row[field]; exists {
				t.Errorf("Row exposes removed field %s", field)
			}
		}
		for _, field := range []string{"stars", "forks"} {
			if !reflect.DeepEqual(dto[field], row[field]) {
				t.Errorf("DTO/Row mismatch for %s: %v vs %v", field, dto[field], row[field])
			}
		}
	}
}

func TestRegistryPrivateAndUnavailableCounts(t *testing.T) {
	for name, config := range map[string]fakeGitHubConfig{
		"private":          {repositoryPayload: map[string]any{"private": true, "visibility": "private", "stargazers_count": 9, "forks_count": 5}},
		"inaccessible":     {repositoryStatus: 403},
		"internal":         {repositoryPayload: map[string]any{"private": false, "visibility": "internal", "stargazers_count": 9, "forks_count": 5}},
		"missing public":   {repositoryPayload: map[string]any{"private": false, "stargazers_count": 9, "forks_count": 5}},
		"invalid count":    {repositoryPayload: map[string]any{"private": false, "visibility": "public", "stargazers_count": -1, "forks_count": 5}},
		"incomplete count": {repositoryPayload: map[string]any{"private": false, "visibility": "public", "stargazers_count": 9}},
		"oversized response": {repositoryPayload: map[string]any{
			"private": false, "visibility": "public", "stargazers_count": 9, "forks_count": 5,
			"padding": strings.Repeat("x", maxRepositorySignalBytes),
		}},
	} {
		t.Run(name, func(t *testing.T) {
			server := newFakeGitHubServer(t, config)
			packages, err := ResolveRegistry(t.Context(),
				Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}, 0,
				Options{HTTPClient: insecureTestClient()})
			if err != nil || len(packages) != 1 {
				t.Fatalf("optional repository lookup must not fail package: %+v, %v", packages, err)
			}
			if packages[0].Stars != nil || packages[0].Forks != nil {
				t.Fatalf("repository without confirmed public counts leaked data: %+v", packages[0])
			}
		})
	}
}

func TestCachedPackageDoesNotPublishLegacySignalFields(t *testing.T) {
	cache := newMemoryCache()
	cache.entries[[2]string{"official", "generation-1"}] = []byte(`{"packages":[{"id":"example/packages/demo","verification-status":"verified","maintenance-status":"active","installation-status":"installed","adoption-count":1,"stars":12}]}`)
	outcome := resolveOneRegistry(t.Context(), Registry{ID: "official", Repository: "example/packages", Ref: "main"}, 0,
		"generation-1", DefaultCacheTTL, cache, Options{})
	if !outcome.cacheHit {
		t.Fatal("expected cache hit")
	}
	data, err := json.Marshal(outcome.packages[0])
	if err != nil {
		t.Fatal(err)
	}
	var dto map[string]any
	if err := json.Unmarshal(data, &dto); err != nil {
		t.Fatal(err)
	}
	for _, field := range excludedPackageFields {
		if _, exists := dto[field]; exists {
			t.Errorf("cached DTO exposes removed field %s", field)
		}
	}
	if dto["stars"] != float64(12) {
		t.Fatalf("cached repository count was lost: %v", dto)
	}
}

func TestDecodeRepositorySignals(t *testing.T) {
	intp := func(value int) *int { return &value }
	cases := []struct {
		name        string
		body        string
		wantStars   *int
		wantForks   *int
		wantOutcome repositorySignalsOutcome
	}{
		{
			name:        "confirmed public repository",
			body:        `{"private":false,"visibility":"public","stargazers_count":9,"forks_count":5}`,
			wantStars:   intp(9),
			wantForks:   intp(5),
			wantOutcome: repositorySignalsOutcomeConfirmed,
		},
		{
			name:        "private repository",
			body:        `{"private":true,"visibility":"private","stargazers_count":9,"forks_count":5}`,
			wantOutcome: repositorySignalsOutcomeNotPublic,
		},
		{
			name:        "internal visibility",
			body:        `{"private":false,"visibility":"internal","stargazers_count":9,"forks_count":5}`,
			wantOutcome: repositorySignalsOutcomeNotPublic,
		},
		{
			name:        "missing visibility field",
			body:        `{"private":false,"stargazers_count":9,"forks_count":5}`,
			wantOutcome: repositorySignalsOutcomeNotPublic,
		},
		{
			name:        "missing private field",
			body:        `{"visibility":"public","stargazers_count":9,"forks_count":5}`,
			wantOutcome: repositorySignalsOutcomeNotPublic,
		},
		{
			name:        "negative count",
			body:        `{"private":false,"visibility":"public","stargazers_count":-1,"forks_count":5}`,
			wantOutcome: repositorySignalsOutcomeInvalidCounts,
		},
		{
			name:        "non-integer count",
			body:        `{"private":false,"visibility":"public","stargazers_count":1.5,"forks_count":5}`,
			wantOutcome: repositorySignalsOutcomeInvalidCounts,
		},
		{
			name:        "missing forks field",
			body:        `{"private":false,"visibility":"public","stargazers_count":9}`,
			wantOutcome: repositorySignalsOutcomeInvalidCounts,
		},
		{
			name:        "malformed json",
			body:        `{not json`,
			wantOutcome: repositorySignalsOutcomeDecodeFailed,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stars, forks, outcome := decodeRepositorySignals([]byte(tc.body))
			if outcome != tc.wantOutcome {
				t.Fatalf("outcome = %s, want %s", outcome, tc.wantOutcome)
			}
			if (stars == nil) != (tc.wantStars == nil) || (stars != nil && *stars != *tc.wantStars) {
				t.Fatalf("stars = %v, want %v", stars, tc.wantStars)
			}
			if (forks == nil) != (tc.wantForks == nil) || (forks != nil && *forks != *tc.wantForks) {
				t.Fatalf("forks = %v, want %v", forks, tc.wantForks)
			}
		})
	}
}
