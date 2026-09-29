package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveCollectorPrivateKeySourcePrefersFile(t *testing.T) {
	source, found := resolveCollectorPrivateKeySource("/path/to/key.pem", "inline-value")
	if !found {
		t.Fatal("expected a configured file path to be found")
	}
	if source != collectorPrivateKeySourceFile {
		t.Fatalf("source = %q, want %q", source, collectorPrivateKeySourceFile)
	}
}

func TestResolveCollectorPrivateKeySourceFallsBackToInline(t *testing.T) {
	source, found := resolveCollectorPrivateKeySource("", "inline-value")
	if !found {
		t.Fatal("expected an inline value to be found")
	}
	if source != collectorPrivateKeySourceInline {
		t.Fatalf("source = %q, want %q", source, collectorPrivateKeySourceInline)
	}
}

func TestResolveCollectorPrivateKeySourceTrimsWhitespaceOnlyValues(t *testing.T) {
	source, found := resolveCollectorPrivateKeySource("   ", "   ")
	if found {
		t.Fatalf("expected whitespace-only values to be treated as absent, got source=%q", source)
	}
}

func TestResolveCollectorPrivateKeySourceReportsAbsentWhenNeitherIsConfigured(t *testing.T) {
	if _, found := resolveCollectorPrivateKeySource("", ""); found {
		t.Fatal("expected no configured input to report absent")
	}
}

func TestCollectorPrivateKeyPrefersFileOverInline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.pem")
	if err := os.WriteFile(path, []byte("-----BEGIN PRIVATE KEY-----file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_COLLECT_PRIVATE_KEY_FILE", path)
	t.Setenv("CAO_COLLECT_PRIVATE_KEY", "inline-should-not-be-used")
	key, err := collectorPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(key) != "-----BEGIN PRIVATE KEY-----file" {
		t.Fatalf("unexpected key material: %q", key)
	}
}

func TestCollectorPrivateKeyReadsInlineWhenNoFileConfigured(t *testing.T) {
	t.Setenv("CAO_COLLECT_PRIVATE_KEY_FILE", "")
	t.Setenv("CAO_COLLECT_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----inline")
	key, err := collectorPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(key) != "-----BEGIN PRIVATE KEY-----inline" {
		t.Fatalf("unexpected key material: %q", key)
	}
}

func TestCollectorPrivateKeyFailsClosedWhenNeitherIsConfigured(t *testing.T) {
	t.Setenv("CAO_COLLECT_PRIVATE_KEY_FILE", "")
	t.Setenv("CAO_COLLECT_PRIVATE_KEY", "")
	if _, err := collectorPrivateKey(); err == nil {
		t.Fatal("expected an error when neither the file nor the inline key is configured")
	}
}

func TestCollectorPrivateKeyFailsWhenConfiguredFileCannotBeRead(t *testing.T) {
	t.Setenv("CAO_COLLECT_PRIVATE_KEY_FILE", filepath.Join(t.TempDir(), "missing.pem"))
	t.Setenv("CAO_COLLECT_PRIVATE_KEY", "inline-should-not-be-used")
	if _, err := collectorPrivateKey(); err == nil {
		t.Fatal("expected an error when the configured private-key file cannot be read")
	}
}
