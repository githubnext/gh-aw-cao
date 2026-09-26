package collect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLakeValidateRejectsMissingOrRelativeDirectory(t *testing.T) {
	if err := (Lake{}).Validate(); err == nil {
		t.Fatal("expected an error for an empty directory")
	}
	if err := (Lake{Directory: "relative/path"}).Validate(); err == nil {
		t.Fatal("expected an error for a relative directory")
	}
	if err := (Lake{Directory: t.TempDir()}).Validate(); err != nil {
		t.Fatalf("unexpected error for a valid directory: %v", err)
	}
}

func TestLakePrepareCreatesLayoutAndSeedsInventory(t *testing.T) {
	lake := Lake{Directory: filepath.Join(t.TempDir(), "lake")}
	if err := lake.Prepare(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	for _, directory := range []string{lake.ShardDirectory(), lake.RunsDirectory(), lake.RecordsDirectory()} {
		if info, err := os.Stat(directory); err != nil || !info.IsDir() {
			t.Fatalf("expected directory %s to exist", directory)
		}
	}
	data, err := os.ReadFile(lake.InventoryPath())
	if err != nil {
		t.Fatalf("read seeded inventory: %v", err)
	}
	if string(data) != "{}\n" {
		t.Fatalf("unexpected seeded inventory content: %q", data)
	}
	// Preparing again must not overwrite an inventory a projection already
	// populated.
	if err := os.WriteFile(lake.InventoryPath(), []byte(`{"sources":1}`), 0o600); err != nil {
		t.Fatalf("seed populated inventory: %v", err)
	}
	if err := lake.Prepare(); err != nil {
		t.Fatalf("second prepare: %v", err)
	}
	data, err = os.ReadFile(lake.InventoryPath())
	if err != nil {
		t.Fatalf("read inventory after second prepare: %v", err)
	}
	if string(data) != `{"sources":1}` {
		t.Fatalf("prepare overwrote a populated inventory: %q", data)
	}
}

func TestLakeForgetRemovesOnlyMatchingShardsAcrossDirectories(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	const target = "octo-cat-widgets"
	const other = "octo-cat-widgets-extra"
	for _, directory := range []string{lake.ShardDirectory(), lake.RunsDirectory(), lake.RecordsDirectory()} {
		for _, name := range []string{
			lake.ShardPrefix(target) + "1.jsonl",
			lake.ShardPrefix(other) + "1.jsonl",
		} {
			if err := os.WriteFile(filepath.Join(directory, name), []byte("{}"), 0o600); err != nil {
				t.Fatalf("seed shard %s: %v", name, err)
			}
		}
	}
	if err := lake.Forget("octo-cat/widgets"); err != nil {
		t.Fatalf("forget: %v", err)
	}
	for _, directory := range []string{lake.ShardDirectory(), lake.RunsDirectory(), lake.RecordsDirectory()} {
		if _, err := os.Stat(filepath.Join(directory, lake.ShardPrefix(target)+"1.jsonl")); !os.IsNotExist(err) {
			t.Fatalf("expected target shard removed in %s, stat err=%v", directory, err)
		}
		if _, err := os.Stat(filepath.Join(directory, lake.ShardPrefix(other)+"1.jsonl")); err != nil {
			t.Fatalf("expected unrelated shard retained in %s: %v", directory, err)
		}
	}
}

func TestLakeForgetRejectsInvalidRepository(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Forget("not-a-repository"); err == nil {
		t.Fatal("expected an error for a malformed repository reference")
	}
}

func TestLakeForgetToleratesMissingDirectories(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Forget("octo-cat/widgets"); err != nil {
		t.Fatalf("forget with no shard directories yet: %v", err)
	}
}

func TestLakePopulatedReflectsManifestAndRunShards(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	populated, err := lake.Populated()
	if err != nil {
		t.Fatalf("populated on empty lake: %v", err)
	}
	if populated {
		t.Fatal("expected an empty lake to be unpopulated")
	}
	if err := lake.Prepare(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := os.WriteFile(lake.ManifestPath(), []byte("{}"), 0o600); err != nil {
		t.Fatalf("seed manifest: %v", err)
	}
	populated, err = lake.Populated()
	if err != nil {
		t.Fatalf("populated with manifest but no run shards: %v", err)
	}
	if populated {
		t.Fatal("expected a lake with no run shards to be unpopulated")
	}
	if err := os.WriteFile(filepath.Join(lake.RunsDirectory(), "runs.jsonl"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("seed run shard: %v", err)
	}
	populated, err = lake.Populated()
	if err != nil {
		t.Fatalf("populated with manifest and run shards: %v", err)
	}
	if !populated {
		t.Fatal("expected a lake with a manifest and a run shard to be populated")
	}
}

func TestRemoveMatchingFilesCountsAndFiltersByPrefix(t *testing.T) {
	directory := t.TempDir()
	for _, name := range []string{"keep-1.jsonl", "match-1.jsonl", "match-2.jsonl"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("{}"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}
	if err := os.Mkdir(filepath.Join(directory, "match-subdir"), 0o750); err != nil {
		t.Fatalf("seed subdirectory: %v", err)
	}
	removed, err := removeMatchingFiles(directory, "match-")
	if err != nil {
		t.Fatalf("removeMatchingFiles: %v", err)
	}
	if removed != 2 {
		t.Fatalf("expected 2 files removed, got %d", removed)
	}
	if _, err := os.Stat(filepath.Join(directory, "keep-1.jsonl")); err != nil {
		t.Fatalf("expected unrelated file retained: %v", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "match-subdir")); err != nil {
		t.Fatalf("expected matching subdirectory retained: %v", err)
	}
}

func TestRemoveMatchingFilesToleratesMissingDirectory(t *testing.T) {
	removed, err := removeMatchingFiles(filepath.Join(t.TempDir(), "missing"), "match-")
	if err != nil {
		t.Fatalf("unexpected error for a missing directory: %v", err)
	}
	if removed != 0 {
		t.Fatalf("expected 0 files removed, got %d", removed)
	}
}
