package marketplace

import (
	"encoding/base64"
	"fmt"
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

func TestDecodeManifestBlobDecodesValidBase64Content(t *testing.T) {
	payload := map[string]any{
		"encoding": "base64",
		"content":  base64.StdEncoding.EncodeToString([]byte(demoManifest)),
	}
	manifest, err := decodeManifestBlob(payload)
	if err != nil {
		t.Fatal(err)
	}
	if manifest != demoManifest {
		t.Fatalf("unexpected decoded manifest: %q", manifest)
	}
}

func TestDecodeManifestBlobToleratesWhitespaceWithinContent(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte(demoManifest))
	// GitHub's blob API wraps base64 content across lines; the decoder must
	// strip that whitespace rather than fail to decode.
	wrapped := encoded[:len(encoded)/2] + "\n" + encoded[len(encoded)/2:]
	manifest, err := decodeManifestBlob(map[string]any{"encoding": "base64", "content": wrapped})
	if err != nil {
		t.Fatal(err)
	}
	if manifest != demoManifest {
		t.Fatalf("unexpected decoded manifest: %q", manifest)
	}
}

func TestDecodeManifestBlobRejectsMissingEncoding(t *testing.T) {
	if _, err := decodeManifestBlob(map[string]any{"content": "abc"}); err == nil {
		t.Fatal("expected a missing encoding to be rejected")
	}
}

func TestDecodeManifestBlobRejectsEmptyContent(t *testing.T) {
	if _, err := decodeManifestBlob(map[string]any{"encoding": "base64", "content": ""}); err == nil {
		t.Fatal("expected empty content to be rejected")
	}
}

func TestDecodeManifestBlobRejectsInvalidBase64(t *testing.T) {
	if _, err := decodeManifestBlob(map[string]any{"encoding": "base64", "content": "!!! not base64 !!!"}); err == nil {
		t.Fatal("expected invalid base64 content to be rejected")
	}
}

func TestResolveRegistryCarriesThePackageReadme(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{readmePaths: []string{"demo/README.md"}})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}
	packages, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()})
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 1 {
		t.Fatalf("expected one package, got: %#v", packages)
	}
	if packages[0].Readme != "# Demo\n\nExample package readme.\n" {
		t.Fatalf("expected the README content to be carried, got: %q", packages[0].Readme)
	}
	if packages[0].ReadmePath != "demo/README.md" {
		t.Fatalf("expected the README path to be carried, got: %q", packages[0].ReadmePath)
	}
}

func TestResolveRegistryLeavesPackagesResolvableWithoutAReadme(t *testing.T) {
	server := newFakeGitHubServer(t, fakeGitHubConfig{})
	registry := Registry{ID: "official", Repository: "example/packages", Ref: "main", APIURL: server.baseURL()}
	packages, err := ResolveRegistry(t.Context(), registry, 0, Options{HTTPClient: insecureTestClient()})
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 1 || packages[0].Readme != "" || packages[0].ReadmePath != "" {
		t.Fatalf("expected a package without README content, got: %#v", packages)
	}
}

func manifestBlob(path, sha string) map[string]any {
	return map[string]any{"type": "blob", "path": path, "sha": sha}
}

func TestManifestTreeEntryAcceptsAnEligiblePackageManifest(t *testing.T) {
	entry, ok := manifestTreeEntry(manifestBlob("packages/triage/aw.yml", "abc"), "packages/")
	if !ok || entry.path != "packages/triage/aw.yml" || entry.sha != "abc" {
		t.Fatalf("manifestTreeEntry = %+v, %v; want eligible triage manifest", entry, ok)
	}
}

func TestManifestTreeEntryRejectsNonBlobShapes(t *testing.T) {
	for name, raw := range map[string]any{
		"not a map":   "triage/aw.yml",
		"tree type":   map[string]any{"type": "tree", "path": "triage/aw.yml", "sha": "abc"},
		"empty path":  manifestBlob("", "abc"),
		"missing sha": manifestBlob("triage/aw.yml", ""),
	} {
		if _, ok := manifestTreeEntry(raw, ""); ok {
			t.Errorf("%s: manifestTreeEntry accepted %v", name, raw)
		}
	}
}

func TestManifestTreeEntryRejectsOutOfScopeAndRootAndInternalPaths(t *testing.T) {
	for _, path := range []string{
		"other/triage/aw.yml",
		"packages/aw.yml",
		"packages/triage/README.md",
		"packages/dashboard/aw.yml",
		"packages/activity/nested/aw.yml",
	} {
		if _, ok := manifestTreeEntry(manifestBlob(path, "abc"), "packages/"); ok {
			t.Errorf("manifestTreeEntry accepted %q", path)
		}
	}
}

func TestManifestEntriesReturnsAllEligibleEntriesWhenUnderTheCap(t *testing.T) {
	rawTree := []any{
		manifestBlob("aw.yml", "root"),
		manifestBlob("triage/aw.yml", "a"),
		manifestBlob("dashboard/aw.yml", "internal"),
		manifestBlob("review/aw.yml", "b"),
	}
	entries, truncated := manifestEntries(rawTree, "")
	if truncated {
		t.Fatal("manifestEntries reported truncation under the cap")
	}
	if len(entries) != 2 || entries[0].path != "triage/aw.yml" || entries[1].path != "review/aw.yml" {
		t.Fatalf("entries = %+v, want triage then review", entries)
	}
}

func TestManifestEntriesReportsTruncationBeyondTheCap(t *testing.T) {
	rawTree := make([]any, 0, maxPackagesPerRegistry+1)
	for i := 0; i < maxPackagesPerRegistry; i++ {
		rawTree = append(rawTree, manifestBlob(fmt.Sprintf("pkg-%d/aw.yml", i), "sha"))
	}
	exact, truncated := manifestEntries(rawTree, "")
	if truncated || len(exact) != maxPackagesPerRegistry {
		t.Fatalf("at the cap: len=%d truncated=%v, want %d and false", len(exact), truncated, maxPackagesPerRegistry)
	}
	rawTree = append(rawTree, manifestBlob("extra/aw.yml", "sha"))
	entries, truncated := manifestEntries(rawTree, "")
	if !truncated || len(entries) != maxPackagesPerRegistry {
		t.Fatalf("beyond the cap: len=%d truncated=%v, want %d and true", len(entries), truncated, maxPackagesPerRegistry)
	}
	if entries[len(entries)-1].path != fmt.Sprintf("pkg-%d/aw.yml", maxPackagesPerRegistry-1) {
		t.Fatalf("last entry = %q, want the last in-cap manifest", entries[len(entries)-1].path)
	}
}
