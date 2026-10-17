package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestRecordWritesStructuredEvent(t *testing.T) {
	var buffer bytes.Buffer
	New(&buffer).Record(context.Background(), "cli_command.admitted", Success, slog.String("actor", "mona"))
	var event map[string]any
	if err := json.Unmarshal(buffer.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["audit"] != "cao" || event["event"] != "cli_command.admitted" || event["outcome"] != Success || event["actor"] != "mona" || event["time"] == nil {
		t.Fatalf("unexpected event %v", event)
	}
	var nilLogger *Logger
	nilLogger.Record(context.Background(), "ignored", Success)
}

func TestFromEnvAppendsWithPrivateMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	if err := os.WriteFile(path, []byte("existing\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_AUDIT_LOG", path)
	logger, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	logger.Record(context.Background(), "admin.denied", Denied)
	content, _ := os.ReadFile(path) // #nosec G304 -- test temporary file
	if !bytes.HasPrefix(content, []byte("existing\n")) || !bytes.Contains(content, []byte(`"admin.denied"`)) {
		t.Fatalf("audit log must append: %q", content)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
}
