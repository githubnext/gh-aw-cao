package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type recordingStore struct {
	events []operational.AuditEvent
	err    error
}

func (r *recordingStore) AppendAudit(_ context.Context, event operational.AuditEvent) (operational.AuditEvent, error) {
	if r.err != nil {
		return operational.AuditEvent{}, r.err
	}
	event.Sequence = int64(len(r.events) + 1)
	r.events = append(r.events, event)
	return event, nil
}
func (r *recordingStore) ListAudit(context.Context, operational.AuditFilter) ([]operational.AuditEvent, error) {
	return r.events, nil
}
func (r *recordingStore) VerifyAudit(context.Context) (operational.AuditVerification, error) {
	return operational.AuditVerification{}, nil
}

func TestRecordStoresEventBeforeMirroring(t *testing.T) {
	var buffer bytes.Buffer
	store := &recordingStore{}
	logger := New(&buffer).WithStore(store)
	if !logger.Durable() || New(&buffer).Durable() {
		t.Fatal("Durable must reflect the store sink")
	}
	at := time.Date(2026, 10, 14, 1, 2, 3, 0, time.FixedZone("x", 3600))
	if err := logger.Record(context.Background(), "token.minted", Success, slog.String("actor", "mona"),
		slog.Any("permissions", map[string]string{"contents": "write"}), slog.Time("expires_at", at), slog.Int64("installation_id", 7)); err != nil {
		t.Fatal(err)
	}
	stored := store.events[0]
	if stored.Actor != "mona" || stored.Attributes["permissions"] != `{"contents":"write"}` ||
		stored.Attributes["expires_at"] != "2026-10-14T00:02:03Z" || stored.Attributes["installation_id"] != "7" || stored.Attributes["actor"] != "" {
		t.Fatalf("stored event = %+v", stored)
	}
	var mirrored map[string]any
	if err := json.Unmarshal(buffer.Bytes(), &mirrored); err != nil {
		t.Fatal(err)
	}
	if mirrored["stored"] != true || mirrored["sequence"] != float64(1) {
		t.Fatalf("mirrored event = %v", mirrored)
	}
}

func TestRecordReportsStorageFailureAndStillMirrors(t *testing.T) {
	var buffer bytes.Buffer
	logger := New(&buffer).WithStore(&recordingStore{err: errors.New("down")})
	if err := logger.Record(context.Background(), "cli_command.admitted", Success); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if !bytes.Contains(buffer.Bytes(), []byte(`"stored":false`)) {
		t.Fatalf("failure must be mirrored: %s", buffer.String())
	}
	var nilLogger *Logger
	if err := nilLogger.WithStore(&recordingStore{}).Record(context.Background(), "x", Success); err != nil {
		t.Fatal(err)
	}
}

func TestRecordWritesStructuredEvent(t *testing.T) {
	var buffer bytes.Buffer
	if err := New(&buffer).Record(context.Background(), "cli_command.admitted", Success, slog.String("actor", "mona")); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(buffer.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["audit"] != "cao" || event["event"] != "cli_command.admitted" || event["outcome"] != Success || event["actor"] != "mona" || event["time"] == nil {
		t.Fatalf("unexpected event %v", event)
	}
	var nilLogger *Logger
	if err := nilLogger.Record(context.Background(), "ignored", Success); err != nil {
		t.Fatal(err)
	}
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
	if err := logger.Record(context.Background(), "admin.denied", Denied); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(path) // #nosec G304 -- test temporary file
	if !bytes.HasPrefix(content, []byte("existing\n")) || !bytes.Contains(content, []byte(`"admin.denied"`)) {
		t.Fatalf("audit log must append: %q", content)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
}
