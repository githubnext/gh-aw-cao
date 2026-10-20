package server

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/operational"
	"github.com/githubnext/gh-cao/server/internal/operational/sqlite"
)

func newHostedCLISQLiteTestStore(t *testing.T, path string) (*sqlite.Store, error) {
	t.Helper()
	owner, err := sqlite.New(t.Context(), path)
	if err != nil {
		return nil, err
	}
	if err := owner.Close(); err != nil {
		return nil, err
	}
	return OpenHostedCLISQLite(t.Context(), path)
}

func TestLocalAuditReaderRequiresProvisionedState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.sqlite")
	if _, closeStore, err := OpenAuditReader(t.Context(), path); err == nil {
		_ = closeStore()
		t.Fatal("audit reader provisioned missing state")
	}
	if _, closeStore, err := OpenAuditStore(t.Context(), path); err == nil {
		_ = closeStore()
		t.Fatal("audit writer provisioned missing state")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("audit open created a file: %v", err)
	}
	writer, err := newHostedCLISQLiteTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	event := operational.AuditEvent{Event: "test.accepted", Outcome: "success"}
	if _, err := writer.AppendAudit(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	reader, closeReader, err := OpenAuditReader(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeReader() }()
	if result, err := reader.VerifyAudit(t.Context()); err != nil || result.Events != 1 {
		t.Fatalf("read-only verify: %+v, %v", result, err)
	}
	if _, err := reader.AppendAudit(t.Context(), event); err == nil {
		t.Fatal("audit reader has write authority")
	}
	runtime, closeRuntime, err := OpenAuditStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeRuntime() }()
	if _, err := runtime.AppendAudit(t.Context(), event); err != nil {
		t.Fatalf("writable verifier lost append authority: %v", err)
	}
}
