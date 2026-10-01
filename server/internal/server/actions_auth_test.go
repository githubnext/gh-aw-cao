package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHostedActionsRepository(t *testing.T) {
	sourcePath := filepath.Join(t.TempDir(), "source-repository")
	if err := os.WriteFile(sourcePath, []byte("other-owner/installed-cao\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name       string
		enabled    bool
		configured string
		sourcePath string
		want       string
	}{
		{"source origin", true, "", sourcePath, "other-owner/installed-cao"},
		{"explicit override", true, "authorized/other", sourcePath, "authorized/other"},
		{"missing origin fails closed", true, "", sourcePath + ".missing", ""},
		{"MCP disabled", false, "", sourcePath, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := hostedActionsRepository(test.enabled, test.configured, test.sourcePath); got != test.want {
				t.Fatalf("hostedActionsRepository() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParseActionsRepository(t *testing.T) {
	for _, test := range []struct {
		name       string
		repository string
		wantOwner  string
		wantName   string
		wantErr    bool
	}{
		{"valid", "githubnext/gh-aw-cao", "githubnext", "gh-aw-cao", false},
		{"trims whitespace", "  githubnext/gh-aw-cao  ", "githubnext", "gh-aw-cao", false},
		{"empty", "", "", "", true},
		{"missing slash", "githubnext", "", "", true},
		{"missing owner", "/gh-aw-cao", "", "", true},
		{"missing name", "githubnext/", "", "", true},
		{"extra segment", "githubnext/gh-aw-cao/extra", "", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			owner, name, err := parseActionsRepository(test.repository)
			if (err != nil) != test.wantErr {
				t.Fatalf("parseActionsRepository(%q) error = %v, wantErr %t", test.repository, err, test.wantErr)
			}
			if err != nil {
				return
			}
			if owner != test.wantOwner || name != test.wantName {
				t.Fatalf("parseActionsRepository(%q) = (%q, %q), want (%q, %q)",
					test.repository, owner, name, test.wantOwner, test.wantName)
			}
		})
	}
}

func TestResolveGitHubAPIBaseURL(t *testing.T) {
	for _, test := range []struct {
		name    string
		rawURL  string
		want    string
		wantErr bool
	}{
		{"blank defaults to public API", "", "https://api.github.com", false},
		{"whitespace defaults to public API", "   ", "https://api.github.com", false},
		{"trims trailing slash", "https://example.test/", "https://example.test", false},
		{"trims whitespace", "  https://example.test  ", "https://example.test", false},
		{"invalid scheme", "not-a-url", "", true},
		{"rejects query", "https://example.test?x=1", "", true},
		{"rejects fragment", "https://example.test#frag", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveGitHubAPIBaseURL(test.rawURL)
			if (err != nil) != test.wantErr {
				t.Fatalf("resolveGitHubAPIBaseURL(%q) error = %v, wantErr %t", test.rawURL, err, test.wantErr)
			}
			if err == nil && got != test.want {
				t.Fatalf("resolveGitHubAPIBaseURL(%q) = %q, want %q", test.rawURL, got, test.want)
			}
		})
	}
}
