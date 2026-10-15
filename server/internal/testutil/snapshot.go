package testutil

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"regexp"
	"testing"
	"time"
)

var evidenceTimestamp = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`)

// ShiftEvidence preserves the relative timing of fixture records.
func ShiftEvidence(t testing.TB, content []byte, offset time.Duration) []byte {
	t.Helper()
	return evidenceTimestamp.ReplaceAllFunc(content, func(value []byte) []byte {
		instant, err := time.Parse(time.RFC3339Nano, string(value))
		if err != nil {
			t.Fatal(err)
		}
		return []byte(instant.Add(offset).Format(time.RFC3339Nano))
	})
}

// RecentSnapshot copies historical evidence into the current retention window
// without changing production retention or the checked-in snapshot.
func RecentSnapshot(t testing.TB, source string) (string, time.Duration) {
	t.Helper()
	directory := t.TempDir()
	if err := os.CopyFS(directory, os.DirFS(source)); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	})
	runs, err := root.ReadFile("gh-aw-logs-runs/subset.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var latest time.Time
	for _, value := range evidenceTimestamp.FindAll(runs, -1) {
		instant, err := time.Parse(time.RFC3339Nano, string(value))
		if err != nil {
			t.Fatal(err)
		}
		if instant.After(latest) {
			latest = instant
		}
	}
	if latest.IsZero() {
		t.Fatal("snapshot requires timestamped run evidence")
	}
	offset := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Microsecond).Sub(latest)
	const manifestPath = "payload-hashes.json"
	content, err := root.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]string
	if err := json.Unmarshal(content, &manifest); err != nil {
		t.Fatal(err)
	}
	for name := range manifest {
		content, err := root.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		content = ShiftEvidence(t, content, offset)
		if err := root.WriteFile(name, content, 0600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(content)
		manifest[name] = hex.EncodeToString(sum[:])
	}
	content, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := root.WriteFile(manifestPath, content, 0600); err != nil {
		t.Fatal(err)
	}
	return directory, offset
}
