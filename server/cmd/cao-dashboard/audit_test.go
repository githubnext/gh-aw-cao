package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

func runAudit(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := newRootCommand()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs(append([]string{"audit"}, args...))
	err := root.Execute()
	return out.String(), err
}

func TestAuditVerifyAndExportSQLite(t *testing.T) {
	t.Setenv("CAO_AUDIT_LOG", filepath.Join(t.TempDir(), "audit.jsonl"))
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	bootstrapSQLite(t, path)
	store, err := server.OpenHostedCLISQLite(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range []string{"octocat", "hubot"} {
		if _, err := store.AppendAudit(t.Context(), operational.AuditEvent{Event: "cli_command.admitted", Outcome: "success", Actor: actor}); err != nil {
			t.Fatal(err)
		}
	}
	_ = store.Close()

	output, err := runAudit(t, "verify", "--sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var head operational.AuditVerification
	if err := json.Unmarshal([]byte(output), &head); err != nil || head.LastSequence != 2 || len(head.LastHash) != 64 {
		t.Fatalf("verify output = %q, %v", output, err)
	}
	anchor := strconv.FormatInt(head.LastSequence, 10) + ":" + head.LastHash
	if _, err := runAudit(t, "verify", "--sqlite", path, "--anchor", anchor); err != nil {
		t.Fatalf("anchored verify: %v", err)
	}
	if _, err := runAudit(t, "verify", "--sqlite", path, "--anchor", "1:"+head.LastHash); err == nil {
		t.Fatal("mismatched anchor verified")
	}
	if _, err := runAudit(t, "verify", "--sqlite", path, "--anchor", "nope"); err == nil {
		t.Fatal("malformed anchor accepted")
	}

	output, err = runAudit(t, "export", "--sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	// Two admissions, then verified, verified, verify_failed from the runs above.
	if len(lines) != 5 || !strings.Contains(lines[2], `"audit.verified"`) || !strings.Contains(lines[4], `"audit.verify_failed"`) {
		t.Fatalf("export = %q", output)
	}
	output, err = runAudit(t, "export", "--sqlite", path, "--actor", "hubot")
	if err != nil || strings.Count(output, "\n") != 1 || !strings.Contains(output, `"hubot"`) {
		t.Fatalf("filtered export = %q, %v", output, err)
	}
}

func TestParseAuditAnchors(t *testing.T) {
	anchors, err := parseAuditAnchors([]string{" 3:abc ", "10:def:ghi"})
	if err != nil || len(anchors) != 2 || anchors[0] != (operational.AuditAnchor{Sequence: 3, Hash: "abc"}) ||
		anchors[1] != (operational.AuditAnchor{Sequence: 10, Hash: "def:ghi"}) {
		t.Fatalf("anchors = %+v, %v", anchors, err)
	}
	if anchors, err := parseAuditAnchors(nil); err != nil || len(anchors) != 0 {
		t.Fatalf("empty anchors = %+v, %v", anchors, err)
	}
	for _, bad := range []string{"nope", "x:abc", ":abc", ""} {
		if _, err := parseAuditAnchors([]string{bad}); err == nil {
			t.Fatalf("anchor %q accepted", bad)
		}
	}
}

func TestVerificationAttrs(t *testing.T) {
	attrs := verificationAttrs(operational.AuditVerification{Events: 4, FirstSequence: 1, LastSequence: 4, LastHash: "h", AnchorsChecked: 2, AnchorsExpired: 1})
	got := map[string]string{}
	for _, attr := range attrs {
		got[attr.Key] = attr.Value.String()
	}
	want := map[string]string{"events": "4", "first_sequence": "1", "last_sequence": "4", "last_hash": "h", "anchors_checked": "2", "anchors_expired": "1"}
	if len(attrs) != len(want) {
		t.Fatalf("attrs = %v", attrs)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %q, want %q", key, got[key], value)
		}
	}
}

func TestExportAuditPagesThroughAllEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	bootstrapSQLite(t, path)
	store, err := server.OpenHostedCLISQLite(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	total := operational.AuditListLimit + 5
	for i := 0; i < total; i++ {
		if _, err := store.AppendAudit(t.Context(), operational.AuditEvent{Event: "cli_command.admitted", Outcome: "success", Actor: "octocat"}); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := exportAudit(t.Context(), store, operational.AuditFilter{}, &out); err != nil {
		t.Fatal(err)
	}
	if lines := strings.Count(out.String(), "\n"); lines != total {
		t.Fatalf("exported %d lines, want %d", lines, total)
	}
	out.Reset()
	if err := exportAudit(t.Context(), store, operational.AuditFilter{AfterSequence: int64(total - 1)}, &out); err != nil || strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("after-filtered export = %q, %v", out.String(), err)
	}
}
