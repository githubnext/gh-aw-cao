package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/auditdelivery"
)

func TestAuditDeliverReportsConfigurationFailure(t *testing.T) {
	t.Setenv("CAO_AUDIT_DELIVERY_URL", "https://user:secret@example.test")
	t.Setenv("CAO_AUDIT_DELIVERY_TOKEN", "secret-token")
	cmd := newRootCommand()
	var stdout, stderr bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{"audit", "deliver", "--stream", "deployment-namespace"})
	err := cmd.Execute()
	if err == nil || stdout.Len() != 0 || strings.Contains(stderr.String(), "secret") || strings.Contains(err.Error(), "user:") {
		t.Fatalf("unsafe failure: out=%q err=%q error=%v", stdout.String(), stderr.String(), err)
	}
	var result auditdelivery.Result
	if err := json.NewDecoder(&stderr).Decode(&result); err != nil || result.Status != "failure" || result.Stage != "configuration" {
		t.Fatalf("missing observable failure: %+v %v", result, err)
	}
}

func TestBootstrapAnchorReadFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "anchor.json")
	if _, err := readBootstrapAnchor(filepath.Dir(path)); err == nil {
		t.Fatal("non-regular bootstrap input accepted")
	}
	if _, err := readBootstrapAnchor(path); err == nil {
		t.Fatal("missing bootstrap anchor accepted")
	}
	for _, body := range []string{"{}", strings.Repeat("x", 17<<10), `{"head":`} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		anchor, err := readBootstrapAnchor(path)
		if body != "{}" && err == nil {
			t.Fatal("invalid bootstrap accepted")
		}
		if body == "{}" && anchor.Head.Sequence != 0 {
			t.Fatal("empty object became trusted anchor")
		}
	}
}
