package marketplace

import (
	"strings"
	"testing"
)

func TestParsePackageManifestNormalizesCoordinatesAndAddCommand(t *testing.T) {
	pkg, err := ParsePackageManifest("name: Demo\nversion: v1\nincludes:\n  - workflow.md\n", Coordinates{
		RegistryID:     "official",
		RegistryName:   "Official",
		Precedence:     0,
		Repository:     "example/packages",
		Path:           "demo/aw.yml",
		Ref:            "main",
		ResolvedCommit: fakeCommitSHA,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantSource := "example/packages/demo@" + fakeCommitSHA
	if pkg.Source != wantSource {
		t.Fatalf("unexpected source coordinate: %q", pkg.Source)
	}
	if pkg.AddCommand != "./cao.sh add "+wantSource {
		t.Fatalf("unexpected add-command: %q", pkg.AddCommand)
	}
	if len(pkg.Contents) != 1 || pkg.Contents[0] != "workflow.md" {
		t.Fatalf("unexpected contents: %#v", pkg.Contents)
	}
	if pkg.Publisher != "example" {
		t.Fatalf("unexpected publisher: %q", pkg.Publisher)
	}
	if pkg.Icon != "workflow" {
		t.Fatalf("expected the default icon, got: %q", pkg.Icon)
	}
	if pkg.ID != "official:"+wantSource {
		t.Fatalf("unexpected id: %q", pkg.ID)
	}
}

func TestParsePackageManifestDefaultsVersionToRef(t *testing.T) {
	pkg, err := ParsePackageManifest("name: Demo\n", Coordinates{Repository: "example/packages", Path: "demo/aw.yml", Ref: "v2", ResolvedCommit: fakeCommitSHA})
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Version != "v2" {
		t.Fatalf("expected version to default to ref, got: %q", pkg.Version)
	}
}

func TestParsePackageManifestRequiresAName(t *testing.T) {
	if _, err := ParsePackageManifest("description: no name here\n", Coordinates{}); err == nil {
		t.Fatal("expected a manifest without a name to be rejected")
	}
}

func TestParsePackageManifestRejectsOversizedManifests(t *testing.T) {
	oversized := "name: Demo\n" + strings.Repeat("#", maxManifestBytes+1)
	if _, err := ParsePackageManifest(oversized, Coordinates{}); err == nil {
		t.Fatal("expected an oversized manifest to be rejected")
	}
}

func TestParsePackageManifestStripsQuotesFromScalarValues(t *testing.T) {
	pkg, err := ParsePackageManifest(`name: "Quoted Demo"`+"\ndescription: 'Single quoted'\n", Coordinates{Repository: "a/b", Ref: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Name != "Quoted Demo" || pkg.Description != "Single quoted" {
		t.Fatalf("unexpected scalar parsing: name=%q description=%q", pkg.Name, pkg.Description)
	}
}

func TestResolveRegistryUsesTheRegistryScopedAPIURL(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{})
	registry := Registry{ID: "enterprise", Repository: "example/packages", Ref: "main", APIURL: server.baseURL() + "/api/v3/"}
	if _, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < server.requestCount(); i++ {
		url := server.requestAt(i).URL.String()
		if !strings.HasPrefix(url, "/api/v3/repos/example/packages") {
			t.Fatalf("expected requests scoped under the registry api-url, got: %s", url)
		}
	}
}

func TestResolveRegistryDefaultsToPublicGitHubAPIWhenNoAPIURLIsConfigured(t *testing.T) {
	if apiBase(Registry{}) != "https://api.github.com" {
		t.Fatalf("unexpected default API base: %q", apiBase(Registry{}))
	}
}

func TestResolveRegistryExcludesTheRegistryRootManifestAndInternalPackages(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{
		manifestPaths: []string{"packages/aw.yml", "packages/demo/aw.yml", "packages/activity/aw.yml", "packages/dashboard/aw.yml"},
	})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main", Path: "packages", APIURL: server.baseURL()}
	packages, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()})
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 1 || packages[0].Path != "packages/demo" {
		t.Fatalf("expected only the demo package to remain, got: %#v", packages)
	}
}

func TestResolveRegistrySkipsPrivateManifests(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{manifest: "name: Demo\nprivate: true\n"})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}
	packages, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()})
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 0 {
		t.Fatalf("expected private packages to be skipped, got: %#v", packages)
	}
}

func TestResolveRegistryFailsWhenTheRefDoesNotResolveToACommit(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{failStatus: 404})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "missing-ref", APIURL: server.baseURL()}
	if _, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()}); err == nil {
		t.Fatal("expected a failing commit lookup to return an error")
	}
}

func TestResolveRegistryRejectsAnInvalidRepositoryShape(t *testing.T) {
	registry := Registry{ID: "official", Repository: "not-a-repository", Ref: "main"}
	if _, err := ResolveRegistry(t.Context(), registry, 0, Options{}); err == nil {
		t.Fatal("expected an invalid repository coordinate to be rejected")
	}
}
