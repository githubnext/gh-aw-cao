package marketplace

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestPackageRepositoryLinkParity(t *testing.T) {
	cases := []struct {
		name, apiURL, href string
	}{
		{"GitHub default", "", "https://github.com/example/packages"},
		{"GitHub API", "https://api.github.com/", "https://github.com/example/packages"},
		{"enterprise", "https://github.example/api/v3/", "https://github.example/example/packages"},
		{"enterprise prefix", "https://github.example/prefix/api/v3", "https://github.example/prefix/example/packages"},
		{"unsupported API", "https://api.other.example/v2", ""},
		{"credential URL", "https://" + "user:ignored@" + "github.example/api/v3", ""},
		{"query URL", "https://github.example/api/v3?token=secret", ""},
		{"insecure URL", "http://github.example/api/v3", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pkg, err := ParsePackageManifest("name: Demo\n", Coordinates{
				Repository: "example/packages", Path: "demo/aw.yml", Ref: "main", APIURL: tc.apiURL,
			})
			if err != nil {
				t.Fatal(err)
			}
			row := pkg.Row()
			data, err := json.Marshal(pkg)
			if err != nil {
				t.Fatal(err)
			}
			var dto map[string]any
			if err := json.Unmarshal(data, &dto); err != nil {
				t.Fatal(err)
			}
			if tc.href == "" {
				if pkg.RepositoryLink != nil {
					t.Fatalf("unsupported URL produced link: %+v", pkg.RepositoryLink)
				}
				if _, exists := row["repository-link"]; exists {
					t.Fatal("unsupported URL produced repository-link row field")
				}
				if _, exists := dto["repository-link"]; exists {
					t.Fatal("unsupported URL produced repository-link DTO field")
				}
				return
			}
			if pkg.RepositoryLink == nil || pkg.RepositoryLink.Relation != "repository" ||
				pkg.RepositoryLink.Href != tc.href ||
				pkg.RepositoryLink.Label != "Open example/packages on GitHub" {
				t.Fatalf("wrong safe link: %+v", pkg.RepositoryLink)
			}
			rowJSON, err := json.Marshal(row["repository-link"])
			if err != nil {
				t.Fatal(err)
			}
			var rowLink map[string]any
			if err := json.Unmarshal(rowJSON, &rowLink); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(rowLink, dto["repository-link"]) {
				t.Fatalf("row and DTO link differ: %v != %v", rowLink, dto["repository-link"])
			}
		})
	}
}

func TestResolveRegistryUsesRegistryAPIURLForLink(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{})
	packages, err := ResolveRegistry(t.Context(), Registry{
		ID: "enterprise", Repository: "example/packages", Ref: "main", APIURL: server.baseURL() + "/api/v3",
	}, 0, Options{HTTPClient: insecureTestClient()})
	if err != nil {
		t.Fatal(err)
	}

	if len(packages) != 1 || packages[0].RepositoryLink == nil ||
		packages[0].RepositoryLink.Href != server.baseURL()+"/example/packages" {
		t.Fatalf("hosted resolution failed to include enterprise repository link: %+v", packages)
	}
}

func TestCachedPackageRepositoryLinkFollowsRegistryURL(t *testing.T) {
	cache := newMemoryCache()
	cache.entries[[2]string{"official", "generation-1"}] = mustMarshalCachedPayload(t, []Package{{
		Repository: "example/packages",
	}})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main"}
	outcome := resolveOneRegistry(t.Context(), registry, 0, "generation-1", DefaultCacheTTL, cache, Options{})
	if !outcome.cacheHit || outcome.packages[0].RepositoryLink == nil ||
		outcome.packages[0].RepositoryLink.Href != "https://github.com/example/packages" {
		t.Fatalf("cached package link not reconstructed from current registry: %+v", outcome)
	}
	registry.APIURL = "https://unsupported.example/api/v2"
	outcome = resolveOneRegistry(t.Context(), registry, 0, "generation-1", DefaultCacheTTL, cache, Options{})
	if outcome.packages[0].RepositoryLink != nil {
		t.Fatalf("cached package retained unsupported repository link: %+v", outcome)
	}
}
