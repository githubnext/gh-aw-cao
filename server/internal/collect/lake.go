package collect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Lake is the durable evidence lake.
//
// It is laid out exactly like an Activity-published snapshot directory, which
// is the decision that lets projection reuse the Actions profile's ingestion
// implementation unchanged and makes cold start a local replay with no GitHub
// requests.
type Lake struct {
	Directory string
}

// Validate reports whether the lake is usable.
func (l Lake) Validate() error {
	if strings.TrimSpace(l.Directory) == "" {
		return errors.New("evidence lake directory is required")
	}
	if !filepath.IsAbs(l.Directory) {
		return errors.New("evidence lake directory must be an absolute path")
	}
	return nil
}

// ShardDirectory holds raw per-repository shards. It doubles as the collection
// CLI's cached-JSONL directory, so each collection reuses known runs.
func (l Lake) ShardDirectory() string {
	return filepath.Join(l.Directory, "gh-aw-logs-shards")
}

// RunsDirectory holds compacted run-information shards.
func (l Lake) RunsDirectory() string {
	return filepath.Join(l.Directory, "gh-aw-logs-runs")
}

// RecordsDirectory holds compacted detailed record shards.
func (l Lake) RecordsDirectory() string {
	return filepath.Join(l.Directory, "gh-aw-logs-records")
}

// InventoryPath is the logical source inventory the projection consumes.
func (l Lake) InventoryPath() string {
	return filepath.Join(l.Directory, "inventory-sources.json")
}

// ManifestPath is the payload-hash manifest that makes the lake verifiable.
func (l Lake) ManifestPath() string {
	return filepath.Join(l.Directory, "payload-hashes.json")
}

// ControlSettingsPath is the synthesized settings file that tells the Activity
// CLI which repositories are in scope during inventory discovery.
func (l Lake) ControlSettingsPath() string {
	return filepath.Join(l.Directory, "control-settings.json")
}

// ShardPrefix is the per-repository shard prefix. It matches the layout the
// Actions profile produces, so shards from either profile are interchangeable.
func (l Lake) ShardPrefix(repository string) string {
	return strings.ReplaceAll(repository, "/", "-") + "-logs-"
}

// Prepare creates the lake layout and seeds the files the projection requires
// to exist.
func (l Lake) Prepare() error {
	if err := l.Validate(); err != nil {
		return err
	}
	for _, directory := range []string{
		l.Directory, l.ShardDirectory(), l.RunsDirectory(), l.RecordsDirectory(),
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return fmt.Errorf("create evidence lake directory: %w", err)
		}
	}
	if _, err := os.Stat(l.InventoryPath()); errors.Is(err, os.ErrNotExist) {
		if err := WriteFileAtomic(l.InventoryPath(), []byte("{}\n")); err != nil {
			return err
		}
	}
	return nil
}

// Forget deletes every shard collected for repository.
//
// Un-enrollment is a withdrawal of consent, so it must erase retained evidence
// and not merely stop collecting. The caller is responsible for requesting a
// projection afterwards, which is what removes the repository's rows from the
// canonical database.
func (l Lake) Forget(repository string) error {
	normalized, err := NormalizeRepository(repository)
	if err != nil {
		return err
	}
	if err := l.Validate(); err != nil {
		return err
	}
	prefix := l.ShardPrefix(normalized)
	for _, directory := range []string{
		l.ShardDirectory(), l.RunsDirectory(), l.RecordsDirectory(),
	} {
		entries, err := os.ReadDir(directory)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return fmt.Errorf("read evidence lake directory: %w", err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) {
				continue
			}
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil &&
				!errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove retained evidence: %w", err)
			}
		}
	}
	return nil
}

// Populated reports whether the lake holds evidence that can repopulate an
// empty canonical database without contacting GitHub.
func (l Lake) Populated() (bool, error) {
	if _, err := os.Stat(l.ManifestPath()); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	entries, err := os.ReadDir(l.RunsDirectory())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".jsonl") {
			return true, nil
		}
	}
	return false, nil
}

// WriteFileAtomic writes a file so a reader observes either the previous
// contents or the complete new contents, never a partial write.
func WriteFileAtomic(path string, content []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".partial-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() {
		_ = os.Remove(name)
	}()
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o600); err != nil {
		return err
	}
	return os.Rename(name, path)
}
