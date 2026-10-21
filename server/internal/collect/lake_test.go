package collect

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShardPrefixesAreDistinctAndPrefixFree(t *testing.T) {
	lake := Lake{}
	repositories := []string{"octo-a/b", "octo/a-b", "octo/a", "octo/a-logs-b", "octo/a.b_c"}
	for _, repository := range repositories {
		if _, err := NormalizeRepository(repository); err != nil {
			t.Fatal(err)
		}
		prefix := lake.ShardPrefix(repository)
		if prefix != lake.ShardPrefix(strings.ToUpper(repository)) {
			t.Fatal("repository case changed the shard identity")
		}
		if !strings.Contains(prefix, "~") {
			t.Fatal("versioned prefix must be outside the legacy filename alphabet")
		}
		for _, other := range repositories {
			if repository != other && strings.HasPrefix(lake.ShardPrefix(other), prefix) {
				t.Fatalf("%s prefix overlaps %s", repository, other)
			}
		}
	}
	if legacyShardPrefix("octo-a/b") != legacyShardPrefix("octo/a-b") {
		t.Fatal("regression fixture does not reproduce the legacy collision")
	}
	maximum := strings.Repeat("a", 39) + "/" + strings.Repeat("b", 100)
	if length := len(lake.ShardPrefix(maximum) + "legacy-1792594800-0000-0123456789abcdef.jsonl"); length > 255 {
		t.Fatalf("valid maximum-length coordinate exceeds filesystem basename limit: %d", length)
	}
}

func writeIdentityShard(t *testing.T, path, repository string) []byte {
	t.Helper()
	content := []byte(`{"request":{"repository":"` + repository + `"}}` + "\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return content
}

func TestForgetPreservesCollidingLegacyAndVersionedEvidence(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{lake.ShardDirectory(), lake.RunsDirectory(), lake.RecordsDirectory()} {
		for i, repository := range []string{"octo-a/b", "octo/a-b"} {
			writeIdentityShard(t, filepath.Join(directory, legacyShardPrefix(repository)+string(rune('1'+i))+".jsonl"), repository)
			writeIdentityShard(t, filepath.Join(directory, lake.ShardPrefix(repository)+"1.jsonl"), repository)
		}
	}
	if err := lake.Forget("Octo-A/B"); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{lake.ShardDirectory(), lake.RunsDirectory(), lake.RecordsDirectory()} {
		for _, name := range []string{legacyShardPrefix("octo/a-b") + "2.jsonl", lake.ShardPrefix("octo/a-b") + "1.jsonl"} {
			if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
				t.Fatalf("unrelated colliding repository evidence lost: %v", err)
			}
		}
		for _, name := range []string{legacyShardPrefix("octo-a/b") + "1.jsonl", lake.ShardPrefix("octo-a/b") + "1.jsonl"} {
			if _, err := os.Stat(filepath.Join(directory, name)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("target evidence retained: %v", err)
			}
		}
	}
}

func TestAmbiguousLegacyShardsFailBeforeMutation(t *testing.T) {
	for _, content := range []string{
		"{}\n", "{broken\n",
		"{\"request\":{\"repository\":\"octo-a/b\"}}\n{\"request\":{\"repository\":\"octo/a-b\"}}\n",
		"{\"request\":{\"repository\":\"octo-a/b\"},\"run\":{\"repository_full_name\":\"octo/a-b\"}}\n",
	} {
		t.Run(content, func(t *testing.T) {
			lake := Lake{Directory: t.TempDir()}
			if err := lake.Prepare(); err != nil {
				t.Fatal(err)
			}
			valid := filepath.Join(lake.ShardDirectory(), lake.ShardPrefix("octo-a/b")+"1.jsonl")
			expected := writeIdentityShard(t, valid, "octo-a/b")
			legacy := filepath.Join(lake.ShardDirectory(), legacyShardPrefix("octo-a/b")+"2.jsonl")
			if err := os.WriteFile(legacy, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := lake.MigrateRepositoryShards(t.Context(), "octo-a/b"); err == nil {
				t.Fatal("ambiguous legacy evidence migrated")
			}
			if err := lake.Forget("octo-a/b"); err == nil {
				t.Fatal("ambiguous legacy erasure reported success")
			}
			actual, err := os.ReadFile(valid) // #nosec G304 -- path is a shard in this test's temporary lake.
			if err != nil || !bytes.Equal(actual, expected) {
				t.Fatalf("valid shard mutated before preflight completed: %v", err)
			}
			actual, err = os.ReadFile(legacy) // #nosec G304 -- path is a shard in this test's temporary lake.
			if err != nil || string(actual) != content {
				t.Fatalf("ambiguous evidence was not preserved: %v", err)
			}
		})
	}
}

func TestMigrateRepositoryShardsPreservesCollidingLegacyOwnersAndReplay(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(lake.ShardDirectory(), legacyShardPrefix("octo-a/b")+"1.jsonl")
	other := filepath.Join(lake.ShardDirectory(), legacyShardPrefix("octo/a-b")+"2.jsonl")
	expected := writeIdentityShard(t, target, "octo-a/b")
	otherContent := writeIdentityShard(t, other, "octo/a-b")
	before, err := lake.RetainedRepositories(t.Context(), 10)
	if err != nil || len(before) != 2 {
		t.Fatalf("legacy replay identities: %v, %v", before, err)
	}
	for range 2 {
		if err := lake.MigrateRepositoryShards(t.Context(), "octo-a/b"); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(lake.ShardDirectory(), lake.ShardPrefix("octo-a/b")+"legacy-1.jsonl")
	actual, err := os.ReadFile(destination) // #nosec G304 -- path is a shard in this test's temporary lake.
	if err != nil || !bytes.Equal(actual, expected) {
		t.Fatalf("migration lost target cache bytes: %v", err)
	}
	actual, err = os.ReadFile(other) // #nosec G304 -- path is a shard in this test's temporary lake.
	if err != nil || !bytes.Equal(actual, otherContent) {
		t.Fatalf("migration changed colliding owner's cache bytes: %v", err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy source not retired: %v", err)
	}
	after, err := lake.RetainedRepositories(t.Context(), 10)
	if err != nil || len(after) != 2 {
		t.Fatalf("mixed-layout replay identities: %v, %v", after, err)
	}
}

func TestMigrateRepositoryShardsNeverClobbersDestinationAndResumesLinks(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "conflict", true: "resume"}[resume], func(t *testing.T) {
			lake := Lake{Directory: t.TempDir()}
			if err := lake.Prepare(); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(lake.ShardDirectory(), legacyShardPrefix("octo/api")+"1.jsonl")
			expected := writeIdentityShard(t, source, "octo/api")
			destination := filepath.Join(lake.ShardDirectory(), lake.ShardPrefix("octo/api")+"legacy-1.jsonl")
			if resume {
				if err := os.Link(source, destination); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(destination, append(expected, '\n'), 0o600); err != nil {
				t.Fatal(err)
			}
			err := lake.MigrateRepositoryShards(t.Context(), "octo/api")
			if resume && err != nil {
				t.Fatal(err)
			}
			if !resume && err == nil {
				t.Fatal("migration replaced existing evidence")
			}
			if !resume {
				actual, err := os.ReadFile(source) // #nosec G304 -- path is a shard in this test's temporary lake.
				if err != nil || !bytes.Equal(actual, expected) {
					t.Fatalf("conflict lost legacy evidence: %v", err)
				}
				actual, err = os.ReadFile(destination) // #nosec G304 -- path is a shard in this test's temporary lake.
				if err != nil || !bytes.Equal(actual, append(expected, '\n')) {
					t.Fatalf("conflict overwrote destination: %v", err)
				}
			}
		})
	}
}

func TestForgetPreflightsEveryDirectoryAndRejectsSymlinks(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	raw := filepath.Join(lake.ShardDirectory(), lake.ShardPrefix("octo/api")+"1.jsonl")
	expected := writeIdentityShard(t, raw, "octo/api")
	link := filepath.Join(lake.RecordsDirectory(), legacyShardPrefix("octo/api")+"1.jsonl")
	if err := os.Symlink(raw, link); err != nil {
		t.Fatal(err)
	}
	if err := lake.Forget("octo/api"); err == nil {
		t.Fatal("symlink accepted for erasure")
	}
	actual, err := os.ReadFile(raw) // #nosec G304 -- path is a shard in this test's temporary lake.
	if err != nil || !bytes.Equal(actual, expected) {
		t.Fatalf("cross-directory preflight deleted valid evidence: %v", err)
	}
}

func TestForgetVerifiesNormalizedRepositoryOwnership(t *testing.T) {
	for _, conflicting := range []bool{false, true} {
		t.Run(map[bool]string{false: "owned", true: "conflicting"}[conflicting], func(t *testing.T) {
			lake := Lake{Directory: t.TempDir()}
			if err := lake.Prepare(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(lake.RunsDirectory(), lake.ShardPrefix("octo/api")+"1.jsonl")
			content := `{"kind":"metadata","phase":"runs"}` + "\n" +
				`{"kind":"record","collection":"repositories","record":{"id":"repository:octo/api","owner":"octo","name":"api"}}` + "\n"
			if conflicting {
				content += `{"kind":"record","collection":"workflows","record":{"repositoryId":"repository:octo/other"}}` + "\n"
			}
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			err := lake.ForgetContext(t.Context(), "octo/api")
			if conflicting {
				if err == nil {
					t.Fatal("conflicting normalized repository identity accepted")
				}
				if _, err := os.Stat(path); err != nil {
					t.Fatalf("ambiguous normalized evidence removed: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("owned normalized evidence retained: %v", err)
				}
			}
		})
	}
}

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

func TestSeedInventoryIfMissingWritesEmptyDocumentAndReportsTrue(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	seeded, err := lake.seedInventoryIfMissing()
	if err != nil {
		t.Fatalf("seed inventory: %v", err)
	}
	if !seeded {
		t.Fatal("expected seeded=true when the inventory did not exist")
	}
	data, err := os.ReadFile(lake.InventoryPath())
	if err != nil {
		t.Fatalf("read seeded inventory: %v", err)
	}
	if string(data) != "{}\n" {
		t.Fatalf("unexpected seeded inventory content: %q", data)
	}
}

func TestSeedInventoryIfMissingSkipsExistingInventoryAndReportsFalse(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := os.MkdirAll(lake.Directory, 0o750); err != nil {
		t.Fatalf("create lake directory: %v", err)
	}
	if err := os.WriteFile(lake.InventoryPath(), []byte(`{"sources":1}`), 0o600); err != nil {
		t.Fatalf("seed populated inventory: %v", err)
	}
	seeded, err := lake.seedInventoryIfMissing()
	if err != nil {
		t.Fatalf("seed inventory: %v", err)
	}
	if seeded {
		t.Fatal("expected seeded=false when the inventory already existed")
	}
	data, err := os.ReadFile(lake.InventoryPath())
	if err != nil {
		t.Fatalf("read inventory: %v", err)
	}
	if string(data) != `{"sources":1}` {
		t.Fatalf("seedInventoryIfMissing overwrote a populated inventory: %q", data)
	}
}

func TestLakeForgetRemovesOnlyMatchingShardsAcrossDirectories(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	const target = "octo-cat/widgets"
	const other = "octo-cat/widgets-extra"
	for _, directory := range []string{lake.ShardDirectory(), lake.RunsDirectory(), lake.RecordsDirectory()} {
		for _, repository := range []string{target, other} {
			name := lake.ShardPrefix(repository) + "1.jsonl"
			if err := os.WriteFile(filepath.Join(directory, name), []byte(`{"request":{"repository":"`+repository+`"}}`), 0o600); err != nil {
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
