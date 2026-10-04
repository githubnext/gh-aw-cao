package ingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestToolEvidenceRetentionPreservesCurrentAndGraceWindow(t *testing.T) {
	directory := t.TempDir()
	root := filepath.Join(directory, "gh-aw-logs-tools")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old := strings.Repeat("a", 64) + ".jsonl.gz"
	current := strings.Repeat("b", 64) + ".jsonl.gz"
	for _, name := range []string{old, current} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("evidence"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(filepath.Join(root, name), now.Add(-24*time.Hour), now.Add(-24*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	first := Manifest{"gh-aw-logs-tools/" + old: strings.Repeat("a", 64)}
	if err := maintainToolEvidence(directory, first, now); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, current), []byte("evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	next := Manifest{"gh-aw-logs-tools/" + current: strings.Repeat("b", 64)}
	if err := maintainToolEvidence(directory, next, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, old)); err != nil {
		t.Fatal("in-flight previous-snapshot reads require the grace window")
	}
	if err := maintainToolEvidence(directory, next, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, old)); !os.IsNotExist(err) {
		t.Fatal("unreferenced expired evidence was not removed")
	}
	if _, err := os.Stat(filepath.Join(root, current)); err != nil {
		t.Fatal("current evidence must survive retention")
	}
}
