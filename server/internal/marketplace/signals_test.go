package marketplace

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRegistrySignalsPublicAndVerifiedPolicy(t *testing.T) {
	now := time.Date(2026, 9, 30, 5, 0, 0, 0, time.UTC)
	server := newFakeGitHubServer(t, fakeGitHubConfig{
		manifestPaths:     []string{"one/aw.yml", "two/aw.yml"},
		manifest:          "name: Demo\nverified-publisher: true\n",
		commitDate:        "2026-09-29T05:00:00+01:00",
		repositoryPayload: map[string]any{"private": false, "visibility": "public", "stargazers_count": 0, "forks_count": 12},
	})
	config, err := ParseConfig([]byte(`{"control-plane":{"marketplace":{"registries":[{"id":"official","repository":"example/packages","ref":"main","verified-publisher":true}]}}}`))
	if err != nil || !config.Registries[0].VerifiedPublisher {
		t.Fatalf("policy verification was not parsed: %+v, %v", config, err)
	}
	registry := config.Registries[0]
	registry.APIURL = server.baseURL()
	packages, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient(), Now: func() time.Time { return now }})
	if err != nil || len(packages) != 2 {
		t.Fatalf("resolve registry: %+v, %v", packages, err)
	}
	repoCalls := 0
	for i := 0; i < server.requestCount(); i++ {
		if server.requestAt(i).URL.Path == "/repos/example/packages" {
			repoCalls++
			if server.requestAt(i).Method != http.MethodGet {
				t.Fatal("repository signal request must be GET")
			}
		}
	}
	if repoCalls != 1 {
		t.Fatalf("wanted one repository signal request per registry, got %d", repoCalls)
	}
	for _, pkg := range packages {
		if pkg.VerificationStatus != "verified" || pkg.VerificationSource != "control-policy" ||
			pkg.MaintenanceStatus != "active" || pkg.MaintenanceSource != "github-repository" ||
			pkg.LastMaintainedAt != "2026-09-29T04:00:00Z" ||
			pkg.Stars == nil || *pkg.Stars != 0 || pkg.Forks == nil || *pkg.Forks != 12 ||
			pkg.PopularitySource != "github-public-repository" || pkg.SignalsObservedAt != "2026-09-30T05:00:00Z" ||
			pkg.InstallationStatus != "unknown" || pkg.AdoptionCount != nil || pkg.AdoptionSource != "unknown" {
			t.Fatalf("unexpected package signals: %+v", pkg)
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
		for _, field := range []string{"verification-status", "verification-source", "maintenance-status", "maintenance-source",
			"last-maintained-at", "stars", "forks", "popularity-source", "signals-observed-at",
			"installation-status", "adoption-count", "adoption-source"} {
			if !reflect.DeepEqual(dto[field], row[field]) {
				t.Errorf("DTO/Row mismatch for %s: %v vs %v", field, dto[field], row[field])
			}
		}
	}
}

func TestRegistrySignalsPrivateAndUnverifiedManifest(t *testing.T) {
	now := time.Date(2026, 9, 30, 5, 0, 0, 0, time.UTC)
	server := newFakeGitHubServer(t, fakeGitHubConfig{
		manifest:          "name: Demo\nverified-publisher: true\n",
		commitDate:        "2025-01-01T00:00:00Z",
		repositoryPayload: map[string]any{"private": true, "visibility": "private", "stargazers_count": 9, "forks_count": 5},
	})
	packages, err := ResolveRegistry(t.Context(), Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL(), VerifiedPublisher: true}, 0,
		Options{HTTPClient: insecureTestClient(), Now: func() time.Time { return now }})
	if err != nil || len(packages) != 1 {
		t.Fatalf("resolve private registry: %+v, %v", packages, err)
	}
	pkg := packages[0]
	if pkg.VerificationStatus != "verified" || pkg.VerificationSource != "control-policy" ||
		pkg.MaintenanceStatus != "unknown" || pkg.MaintenanceSource != "unknown" ||
		pkg.LastMaintainedAt != "" || pkg.Stars != nil || pkg.Forks != nil || pkg.PopularitySource != "unknown" {
		t.Fatalf("private repository leaked signals: %+v", pkg)
	}
	packages, err = ResolveRegistry(t.Context(), Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}, 0,
		Options{HTTPClient: insecureTestClient(), Now: func() time.Time { return now }})
	if err != nil || packages[0].VerificationStatus != "unknown" || packages[0].VerificationSource != "unknown" {
		t.Fatalf("manifest must not verify publisher: %+v, %v", packages, err)
	}
}

func TestRegistrySignalsStaleAndOptionalFailure(t *testing.T) {
	now := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, date, status, maintenance, source string
		repoStatus                              int
	}{
		{"stale", "2026-01-01T00:00:00Z", "stale", "2026-01-01T00:00:00Z", "github-repository", 0},
		{"exact boundary", now.Add(-180 * 24 * time.Hour).Format(time.RFC3339), "active", now.Add(-180 * 24 * time.Hour).Format(time.RFC3339), "github-repository", 0},
		{"bad date", "not-a-date", "unknown", "", "unknown", 0},
		{"future date", "2027-01-01T00:00:00Z", "unknown", "", "unknown", 0},
		{"inaccessible", "2026-01-01T00:00:00Z", "unknown", "", "unknown", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := newFakeGitHubServer(t, fakeGitHubConfig{
				commitDate: tc.date, repositoryStatus: tc.repoStatus,
				repositoryPayload: map[string]any{"private": false, "visibility": "public", "stargazers_count": 3, "forks_count": 4},
			})
			packages, err := ResolveRegistry(t.Context(), Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}, 0,
				Options{HTTPClient: insecureTestClient(), Now: func() time.Time { return now }})
			if err != nil || len(packages) != 1 {
				t.Fatalf("optional signals must not fail registry: %+v, %v", packages, err)
			}

			pkg := packages[0]
			if pkg.MaintenanceStatus != tc.status || pkg.LastMaintainedAt != tc.maintenance || pkg.MaintenanceSource != tc.source {
				t.Fatalf("unexpected maintenance: %+v", pkg)
			}
			if tc.repoStatus != 0 && (pkg.Stars != nil || pkg.Forks != nil || pkg.PopularitySource != "unknown") {
				t.Fatalf("inaccessible repository leaked popularity: %+v", pkg)
			}
		})
	}
}

func TestOversizedRepositorySignalsDoNotFailPackages(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{
		commitDate: "2026-09-29T00:00:00Z",
		repositoryPayload: map[string]any{
			"private": false, "visibility": "public", "stargazers_count": 3, "forks_count": 4,
			"padding": strings.Repeat("x", maxRepositorySignalBytes),
		},
	})
	packages, err := ResolveRegistry(t.Context(),
		Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}, 0,
		Options{HTTPClient: insecureTestClient(), Now: func() time.Time {
			return time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
		}})
	if err != nil || len(packages) != 1 {
		t.Fatalf("large optional response must not fail package: %+v, %v", packages, err)
	}
	pkg := packages[0]
	if pkg.MaintenanceStatus != "unknown" || pkg.LastMaintainedAt != "" || pkg.MaintenanceSource != "unknown" ||
		pkg.Stars != nil || pkg.Forks != nil || pkg.PopularitySource != "unknown" {
		t.Fatalf("oversized repository response exposed signals: %+v", pkg)
	}
}

func TestRegistrySignalsRequireExplicitPublicVisibilityAndValidCounts(t *testing.T) {
	for name, repo := range map[string]map[string]any{
		"internal":       {"private": false, "visibility": "internal", "stargazers_count": 3, "forks_count": 4},
		"missing public": {"private": false, "stargazers_count": 3, "forks_count": 4},
		"bad counts":     {"private": false, "visibility": "public", "stargazers_count": -1, "forks_count": 4},
	} {
		t.Run(name, func(t *testing.T) {
			server := newFakeGitHubServer(t, fakeGitHubConfig{
				commitDate: "2026-01-01T00:00:00Z", repositoryPayload: repo,
			})
			packages, err := ResolveRegistry(t.Context(),
				Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}, 0,
				Options{HTTPClient: insecureTestClient(), Now: func() time.Time { return time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC) }})
			if err != nil {
				t.Fatal(err)
			}

			pkg := packages[0]
			if pkg.Stars != nil || pkg.Forks != nil || pkg.PopularitySource != "unknown" {
				t.Fatalf("non-public or invalid counts leaked popularity: %+v", pkg)
			}
			if name != "bad counts" && (pkg.MaintenanceStatus != "unknown" || pkg.LastMaintainedAt != "") {
				t.Fatalf("non-public repository leaked maintenance: %+v", pkg)
			}
		})
	}
}

func TestCachedVerificationAlwaysFollowsCurrentPolicy(t *testing.T) {
	cache := newMemoryCache()
	cache.entries[[2]string{"official", "generation-1"}] = mustMarshalCachedPayload(t, []Package{{
		ID: "example/packages/demo", VerificationStatus: "verified", VerificationSource: "control-policy",
	}})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main"}
	outcome := resolveOneRegistry(t.Context(), registry, 0, "generation-1", DefaultCacheTTL, cache, Options{})
	if !outcome.cacheHit || outcome.packages[0].VerificationStatus != "unknown" || outcome.packages[0].VerificationSource != "unknown" {
		t.Fatalf("revoked policy verification must not survive cache hit: %+v", outcome)
	}
	registry.VerifiedPublisher = true
	outcome = resolveOneRegistry(t.Context(), registry, 0, "generation-1", DefaultCacheTTL, cache, Options{})
	if !outcome.cacheHit || outcome.packages[0].VerificationStatus != "verified" || outcome.packages[0].VerificationSource != "control-policy" {
		t.Fatalf("current policy verification must override cache: %+v", outcome)
	}
}
