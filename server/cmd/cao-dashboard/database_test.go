package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

func TestDatabaseCommandsRequireExplicitAuthority(t *testing.T) {
	t.Setenv("CAO_DATABASE_ADMIN_URL", "")
	t.Setenv("CAO_POSTGRES_URL", "postgres://runtime@127.0.0.1/runtime")
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"bootstrap"}, "--store"},
		{[]string{"bootstrap", "--store", "operational"}, "--namespace"},
		{[]string{"bootstrap", "--store", "operational", "--namespace", "deployment"}, "CAO_DATABASE_ADMIN_URL"},
		{[]string{"maintain", "--store", "operational", "--namespace", "deployment"}, "maintain requires"},
		{[]string{"retain-audit", "--store", "canonical", "--namespace", "deployment"}, "retain-audit requires"},
	} {
		cmd := newDatabaseCommand()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetArgs(test.args)
		if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("%v: got %v, want %s", test.args, err, test.want)
		}
	}
}

func runDatabase(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newRootCommand()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(append([]string{"database"}, args...))
	err := cmd.Execute()
	return out.String(), err
}

func bootstrapSQLite(t *testing.T, path string) {
	t.Helper()
	if _, err := runDatabase(t, "bootstrap", "--store", "operational", "--sqlite", path); err != nil {
		t.Fatal(err)
	}
}

func TestDatabaseSQLiteLifecycle(t *testing.T) {
	t.Setenv("CAO_DATABASE_ADMIN_URL", "")
	t.Setenv("CAO_POSTGRES_URL", "")
	path := filepath.Join(t.TempDir(), "local.sqlite")
	for _, action := range []string{"retain-audit", "bootstrap"} {
		out, err := runDatabase(t, action, "--store", "operational", "--sqlite", path)
		if action == "retain-audit" {
			if err == nil || out != "" {
				t.Fatalf("retention bootstrapped missing state: %q, %v", out, err)
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("retention created a file: %v", err)
			}
			continue
		}
		assertSQLiteDatabaseResult(t, out, err, action, 0)
	}
	seedSQLiteAuditHistory(t, path, time.Now().Add(-2*operational.AuditRetention), 3)
	// Repeated bootstrap is non-destructive even when all events are expired.
	out, err := runDatabase(t, "bootstrap", "--store", "operational", "--sqlite", path)
	assertSQLiteDatabaseResult(t, out, err, "bootstrap", 0)
	store, err := server.OpenHostedCLISQLite(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if head, err := store.VerifyAudit(t.Context()); err != nil || head.Events != 3 {
		t.Fatalf("bootstrap/runtime open deleted history: %+v, %v", head, err)
	}
	out, err = runDatabase(t, "retain-audit", "--store", "operational", "--sqlite", path)
	assertSQLiteDatabaseResult(t, out, err, "retain-audit", 2)
	if head, err := store.VerifyAudit(t.Context()); err != nil || head.Events != 1 || head.LastSequence != 3 {
		t.Fatalf("explicit retention: %+v, %v", head, err)
	}
	if event, err := store.AppendAudit(t.Context(), operational.AuditEvent{Event: "test.current", Outcome: "success"}); err != nil || event.Sequence != 4 {
		t.Fatalf("runtime append after retention: %+v, %v", event, err)
	}
}

func TestDatabaseSQLiteRejectsUnsupportedScope(t *testing.T) {
	path := filepath.Join(t.TempDir(), "local.sqlite")
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"bootstrap", "--sqlite", path}, "--store"},
		{[]string{"bootstrap", "--store", "operational", "--sqlite="}, "--sqlite requires"},
		{[]string{"bootstrap", "--store", "canonical", "--sqlite", path}, "canonical storage requires PostgreSQL"},
		{[]string{"maintain", "--store", "operational", "--sqlite", path}, "--sqlite supports"},
		{[]string{"retain-audit", "--store", "canonical", "--sqlite", path}, "--sqlite supports"},
		{[]string{"bootstrap", "--store", "operational", "--namespace", "ignored", "--sqlite", path}, "--namespace is not supported"},
	} {
		out, err := runDatabase(t, test.args...)
		if err == nil || !strings.Contains(err.Error(), test.want) || out != "" {
			t.Fatalf("%v: out=%q err=%v; want %s", test.args, out, err, test.want)
		}
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid arguments created state: %v", err)
	}
}

func assertSQLiteDatabaseResult(t *testing.T, out string, err error, action string, removed int64) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Action             string `json:"action"`
		Store              string `json:"store"`
		Backend            string `json:"backend"`
		AuditEventsRemoved int64  `json:"audit_events_removed"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil || result.Action != action ||
		result.Store != "operational" || result.Backend != "sqlite" || result.AuditEventsRemoved != removed {
		t.Fatalf("database result = %q, %v", out, err)
	}
}

func seedSQLiteAuditHistory(t *testing.T, path string, at time.Time, count int) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	prev := operational.AuditGenesis()
	for sequence := 1; sequence <= count; sequence++ {
		event := operational.AuditEvent{Sequence: int64(sequence), OccurredAt: at.UTC(), Event: "test.accepted", Outcome: "success"}
		record, err := operational.CanonicalAuditRecord(event)
		if err != nil {
			t.Fatal(err)
		}
		hash := operational.AuditChainHash(prev, record)
		if _, err := db.ExecContext(t.Context(), `INSERT INTO cao_operational_audit_events
					(sequence,occurred_at,event,outcome,actor,record,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?)`,
			event.Sequence, at.UnixNano(), event.Event, event.Outcome, event.Actor, string(record), prev, hash); err != nil {
			t.Fatal(err)
		}
		prev = hash
	}
}
