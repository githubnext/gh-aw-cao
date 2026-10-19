package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalProfileIsOwnedByServerAndHasOfflineHelp(t *testing.T) {
	t.Setenv("PATH", "")
	command := newRootCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs([]string{"serve-local", "--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{"--data", "--canvas", "--data-backend", "--replace-existing", "--command-concurrency"} {
		if !strings.Contains(output.String(), flag) {
			t.Fatalf("local server help omitted %s", flag)
		}
	}
	local := newServeLocalCommand()
	hosted := newServeHostedCommand()
	if local.Flags().Lookup("operational-store") != nil || hosted.Flags().Lookup("operational-store") == nil {
		t.Fatal("local SQLite serving and reviewed hosted operational flags were conflated")
	}
}

func TestLocalProcessRecordRejectsSymlink(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "process.json")
	if err := os.WriteFile(outside, []byte(`{"pid":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, ".cao-dashboard-dev-server.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := readDashboardProcessRecord(workspace); err == nil {
		t.Fatal("local server read an external process record through a symlink")
	}
}

func TestLocalTraceRemainsWorkspaceConfined(t *testing.T) {
	workspace := t.TempDir()
	for _, name := range []string{"../outside.jsonl", filepath.Join(t.TempDir(), "outside.jsonl")} {
		if trace, err := newDashboardTrace(workspace, name); err == nil {
			_ = trace.Close()
			t.Fatal("local trace escaped its workspace")
		}
	}
	trace, err := newDashboardTrace(workspace, filepath.Join("traces", "local.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	trace.Record(map[string]any{"event": "server.stopped"})
	if err := trace.Close(); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	content, err := root.ReadFile(filepath.Join("traces", "local.jsonl"))
	if err != nil || !bytes.Contains(content, []byte("server.stopped")) {
		t.Fatalf("trace missing: %s %v", content, err)
	}
}
