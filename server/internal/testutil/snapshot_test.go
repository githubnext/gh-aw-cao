package testutil

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRecentSnapshotPreservesEvidenceAndHashes(t *testing.T) {
	source := "../../testdata/deployed-subset"
	before, err := os.ReadFile(filepath.Join(source, "gh-aw-logs-runs/subset.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	directory, offset := RecentSnapshot(t, source)
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	})
	content, err := root.ReadFile("payload-hashes.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]string
	if err := json.Unmarshal(content, &manifest); err != nil {
		t.Fatal(err)
	}
	for name, expected := range manifest {
		content, err := root.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(content)
		if hex.EncodeToString(sum[:]) != expected {
			t.Fatalf("rebased %s has an invalid payload hash", name)
		}
		if strings.Contains(string(content), `"id":"run:424242"`) && !strings.Contains(string(content), `"githubRunId":"424242"`) {
			t.Fatal("rebasing changed canonical run identity")
		}
		for _, value := range evidenceTimestamp.FindAll(content, -1) {
			instant, err := time.Parse(time.RFC3339Nano, string(value))
			if err != nil {
				t.Fatal(err)
			}
			age := time.Since(instant)
			if age < 0 || age > 48*time.Hour {
				t.Fatalf("rebased timestamp is outside the current retention window: %s", value)
			}
		}
	}
	after, err := os.ReadFile(filepath.Join(source, "gh-aw-logs-runs/subset.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("rebasing changed the checked-in snapshot")
	}
	if string(ShiftEvidence(t, before, offset)) == string(before) {
		t.Fatal("historical fixture timestamps were not shifted")
	}
}

func TestShiftEvidencePreservesRelativeTiming(t *testing.T) {
	content := []byte(`{"start":"2020-01-01T23:59:00Z","end":"2020-01-02T00:01:00Z","id":"run:424242","value":7}`)
	got := ShiftEvidence(t, content, 24*time.Hour)
	want := `{"start":"2020-01-02T23:59:00Z","end":"2020-01-03T00:01:00Z","id":"run:424242","value":7}`
	if string(got) != want {
		t.Fatalf("rebased evidence = %s, want %s", got, want)
	}
}
