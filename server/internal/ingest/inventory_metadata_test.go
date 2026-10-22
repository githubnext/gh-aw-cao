package ingest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestReadInventoryMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inventory-sources.json")
	metadata, err := ReadInventoryMetadata(context.Background(), path)
	if err != nil || len(metadata) != 0 {
		t.Fatalf("missing evidence must retain unknown quality: %v %v", metadata, err)
	}
	content := `{"repositories":{"rows":[{"nested":{"ignored":[1,2]}}],
		"metadata":{"completeness":"partial","freshness":"fresh","availability":"available","as-of":"2026-10-01T00:00:00Z","not-quality":"ignored"}},
		"workflows":[],"untrusted-projection":{"metadata":{"completeness":"complete"}}}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	metadata, err = ReadInventoryMetadata(context.Background(), path)
	if err != nil || len(metadata) != 1 || len(metadata["$repositories"]) != 4 ||
		metadata["$repositories"]["completeness"] != "partial" {
		t.Fatalf("invalid published quality: %v %v", metadata, err)
	}
	for _, content := range []string{`[]`, `{"repositories":null}`, `{"workflows":{"metadata":[]}}`, `{} {}`} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInventoryMetadata(context.Background(), path); err == nil {
			t.Fatalf("accepted malformed metadata: %s", content)
		}
	}
}
