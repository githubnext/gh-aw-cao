package ingest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var evidenceShardName = regexp.MustCompile(`^[a-f0-9]{64}\.jsonl\.gz$`)

// Run only after activation. Recently superseded shards remain readable by
// in-flight requests to the preceding committed snapshot.
func maintainToolEvidence(directory string, manifest Manifest, now time.Time) error {
	root := filepath.Join(directory, "gh-aw-logs-tools")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	active := map[string]bool{}
	for name := range manifest {
		if filepath.ToSlash(filepath.Dir(name)) == "gh-aw-logs-tools" && evidenceShardName.MatchString(filepath.Base(name)) {
			active[filepath.Base(name)] = true
		}
	}
	var previous struct {
		Version int             `json:"version"`
		Names   map[string]bool `json:"names"`
	}
	statePath := filepath.Join(root, ".active.json")
	// #nosec G304,G703 -- administrative state has a fixed name beneath the operator-selected evidence directory.
	content, err := os.ReadFile(statePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if json.Unmarshal(content, &previous) != nil || previous.Version != 1 {
			return errors.New("tool evidence maintenance state is incompatible")
		}
	}
	for name := range previous.Names {
		if !evidenceShardName.MatchString(name) {
			return errors.New("tool evidence maintenance state contains an unsafe shard name")
		}
		if active[name] {
			continue
		}
		if err := os.Chtimes(filepath.Join(root, name), now, now); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	state, err := json.Marshal(struct {
		Version int             `json:"version"`
		Names   map[string]bool `json:"names"`
	}{1, active})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(root, ".active-")
	if err != nil {
		return err
	}
	// #nosec G703 -- os.CreateTemp produced this exact path beneath the fixed evidence directory.
	defer func() { _ = os.Remove(temporary.Name()) }()
	if _, err := temporary.Write(state); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	// #nosec G703 -- both paths are generated locally beneath the fixed evidence directory.
	if err := os.Rename(temporary.Name(), statePath); err != nil {
		return err
	}
	deleted := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !evidenceShardName.MatchString(name) || active[name] || previous.Names[name] {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.ModTime().Before(now.Add(-time.Hour)) {
			continue
		}
		// #nosec G703 -- name passed the content-addressed shard regex and is not an active reference.
		if err := os.Remove(filepath.Join(root, name)); err != nil {
			return fmt.Errorf("remove expired Tool evidence: %w", err)
		}
		deleted++
	}
	if deleted > 0 {
		ingestLog.Printf("expired unreferenced Tool evidence shards=%d", deleted)
	}
	return nil
}

func reportToolEvidenceMaintenance(directory string, manifest Manifest) {
	if err := maintainToolEvidence(directory, manifest, time.Now()); err != nil {
		// Data activation already succeeded; surface optional maintenance failure
		// without reporting that the committed ingestion was rolled back.
		ingestLog.Printf("Tool evidence maintenance incomplete: %v", err)
	}
}
