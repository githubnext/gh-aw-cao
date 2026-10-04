package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func writeEvidenceFixture(t *testing.T, directory string, events []model.Row) model.Row {
	t.Helper()
	var content bytes.Buffer
	encoder := json.NewEncoder(&content)
	if err := encoder.Encode(map[string]any{"kind": "tool-evidence", "schemaVersion": model.CanonicalSchemaVersion, "events": len(events)}); err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if err := encoder.Encode(map[string]any{"kind": "tool-event", "record": event}); err != nil {
			t.Fatal(err)
		}
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(content.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(compressed.Bytes())
	digest := hex.EncodeToString(sum[:])
	root := filepath.Join(directory, "gh-aw-logs-tools")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, digest+".jsonl.gz"), compressed.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return model.Row{"run-id": "run", "payload-ref": "gh-aw-logs-tools/" + digest + ".jsonl.gz",
		"payload-hash": digest, "event-count": len(events)}
}

func TestExactToolEvidenceIsBoundedAndFailsUnavailable(t *testing.T) {
	directory := t.TempDir()
	events := []model.Row{
		{"id": "call", "runId": "run", "type": "tool.call", "timestamp": "2026-10-03T14:00:00Z"},
		{"id": "outcome", "runId": "run", "type": "tool.error", "status": "incomplete", "timestamp": "2026-10-03T14:00:01Z"},
	}
	reference := writeEvidenceFixture(t, directory, events)
	result, err := readToolEventEvidence(t.Context(), directory, "run", []model.Row{reference}, 1, "")
	if err != nil || result.TotalEvents != 2 || result.ReturnedEvents != 1 || result.OmittedEvents != 1 || result.Rows[0]["id"] != "outcome" {
		t.Fatalf("bounded exact evidence changed: %+v %v", result, err)
	}
	if _, err := readToolEventEvidence(t.Context(), directory, "run", nil, 20, ""); err == nil {
		t.Fatal("missing evidence must not be a successful empty history")
	}
	reference["event-count"] = 3
	if _, err := readToolEventEvidence(t.Context(), directory, "run", []model.Row{reference}, 20, ""); err == nil {
		t.Fatal("incorrect owning-Run event count must fail")
	}
	reference["payload-ref"] = "../outside"
	if _, err := readToolEventEvidence(t.Context(), directory, "run", []model.Row{reference}, 20, ""); err == nil {
		t.Fatal("unmanifested path must fail")
	}
}

func TestExactToolEvidenceOutputHasByteBudget(t *testing.T) {
	directory := t.TempDir()
	var references []model.Row
	for index := 0; index < 20; index++ {
		event := model.Row{"id": string(rune('a' + index)), "runId": "run", "type": "tool.call",
			"timestamp": "2026-10-03T14:00:00Z", "summary": strings.Repeat("x", 600000)}
		references = append(references, writeEvidenceFixture(t, directory, []model.Row{event}))
	}
	if _, err := readToolEventEvidence(t.Context(), directory, "run", references, 2000, ""); err == nil || !strings.Contains(err.Error(), "byte budget") {
		t.Fatalf("oversized output must fail closed, not retain hundreds of MiB: %v", err)
	}
}
