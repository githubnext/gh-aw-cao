package redisx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeNamespace(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{input: "team-one", expected: "cao:team-one"},
		{input: " CAO:Team_One ", expected: "cao:team_one"},
		{input: "9", expected: "cao:9"},
	}
	for _, test := range tests {
		actual, err := NormalizeNamespace(test.input)
		if err != nil {
			t.Fatalf("NormalizeNamespace(%q): %v", test.input, err)
		}
		if actual != test.expected {
			t.Fatalf("NormalizeNamespace(%q) = %q, want %q", test.input, actual, test.expected)
		}
	}
	for _, input := range []string{"", "cao:", "team*", "team?", "team[1]", "team:name", "team.name", strings.Repeat("a", 65)} {
		if _, err := NormalizeNamespace(input); err == nil {
			t.Errorf("NormalizeNamespace(%q) accepted an ambiguous namespace", input)
		}
	}
}

func TestDefaultNamespaceIsStablePerCheckout(t *testing.T) {
	checkout := t.TempDir()
	if err := os.WriteFile(filepath.Join(checkout, ".git"), []byte("gitdir: test"), 0o600); err != nil {
		t.Fatal(err)
	}
	serverDirectory := filepath.Join(checkout, "server", "internal")
	if err := os.MkdirAll(serverDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	fromRoot, err := DefaultNamespace(checkout)
	if err != nil {
		t.Fatal(err)
	}
	fromServer, err := DefaultNamespace(serverDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if fromRoot != fromServer {
		t.Fatalf("checkout namespace changed by working directory: %q != %q", fromRoot, fromServer)
	}
	other, err := DefaultNamespace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if other == fromRoot {
		t.Fatalf("different checkout paths shared namespace %q", fromRoot)
	}
	if !strings.HasPrefix(fromRoot, namespacePrefix+"checkout-") || len(fromRoot) > 64 {
		t.Fatalf("unexpected default namespace %q", fromRoot)
	}
}

func TestStoreNamespacesUseDisjointKeysAndIndexes(t *testing.T) {
	first := NewStore(&Client{}, "first")
	second := NewStore(&Client{}, "second")
	firstNames := []string{
		first.activeKey(),
		first.activeGenerationKey(),
		first.revisionSequenceKey(),
		first.generationKey("generation"),
		first.sourceSetKey("generation", "runs"),
		first.rowPrefix("generation", "runs") + "row",
		first.generationsKey(),
	}
	secondNames := []string{
		second.activeKey(),
		second.activeGenerationKey(),
		second.revisionSequenceKey(),
		second.generationKey("generation"),
		second.sourceSetKey("generation", "runs"),
		second.rowPrefix("generation", "runs") + "row",
		second.generationsKey(),
	}
	for i := range firstNames {
		if firstNames[i] == secondNames[i] {
			t.Fatalf("namespaces shared Redis name %q", firstNames[i])
		}
		if !strings.HasPrefix(firstNames[i], "cao:first:") {
			t.Fatalf("first store name is not namespaced: %q", firstNames[i])
		}
		if !strings.HasPrefix(secondNames[i], "cao:second:") {
			t.Fatalf("second store name is not namespaced: %q", secondNames[i])
		}
	}
}
