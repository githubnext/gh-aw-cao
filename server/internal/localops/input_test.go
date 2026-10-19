package localops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadOnlyPreviewDoesNotInitializeCommandQueue(t *testing.T) {
	t.Setenv("CAO_DASHBOARD_URL", "")
	approved := false
	s := service(t, func(o *Options) {
		o.Admin = false
		o.Canvas = false
		o.Approve = func(context.Context, Invocation) (bool, error) { approved = true; return true, nil }
	})
	if s.queue != nil {
		t.Fatal("read-only preview initialized command queue")
	}
	for _, operation := range []string{"queue.list", "queue.sources", "queue.detail", "queue.output", "queue.enqueue", "queue.cancel", "queue.retry"} {
		statusError(t, s.Call(t.Context(), operation, map[string]any{"id": 1, "body": map[string]any{"id": "complete"}}, nil), 404)
	}
	if approved {
		t.Fatal("read-only mode reached an approval callback")
	}
	for _, path := range []string{"cli-actions.sqlite", "cli-actions.sqlite.owner.sqlite"} {
		if _, err := os.Stat(filepath.Join(s.options.Workspace, ".cao", path)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("read-only queue file exists: %s %v", path, err)
		}
	}
	s.github.readToken = func(context.Context) ([]byte, error) { return []byte("test-credential"), nil }
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		return githubReply(t, 200, nil, githubRepository), nil
	}
	if value := call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/repo"}); value["status"] != float64(200) {
		t.Fatal(value)
	}
	if s.DashboardURL() != "" {
		t.Fatal("read-only mode inferred a command URL")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCommandCredentialFallbackIsRedactedAndReleased(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("LOCALOPS_ECHO_CREDENTIAL", "1")
	s := service(t, nil)
	value := enqueue(t, s, "complete")
	completed := waitJob(t, s, value["id"], "completed")
	if completed["stdout"] != "[REDACTED]\n" {
		t.Fatal("CLI credential fallback was not passed or redacted")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if len(s.queue.credentials) != 0 {
		t.Fatal("completed command retained its credential")
	}
}

func TestReviewedAgentTaskInputAndModelArePreserved(t *testing.T) {
	s := service(t, nil)
	input := `{"title":"Reviewed task","prompt":"Use only reviewed evidence 😀","model":"claude-sonnet-4.5"}`
	value := call(t, s, "queue.enqueue", map[string]any{"body": map[string]any{"id": "task", "input": input}})
	completed := waitJob(t, s, value["id"], "completed")
	if completed["input"] != input || completed["stdout"] != input {
		t.Fatal("reviewed input/model changed", completed)
	}
	document := fixtureDocument()
	actionByID(document, "local")["command"] = "gh aw compile --model {{model}}"
	model := "openai/gpt-5.1"
	invocation, err := ResolveAction(document, map[string]any{"id": "local", "values": map[string]string{"model": model}}, nil)
	if err != nil || invocation.Command != "gh aw compile --model "+model {
		t.Fatal(invocation, err)
	}
	for _, model := range []string{"model --secret=value", "model;operation", "model\noperation"} {
		if _, err = ResolveAction(document, map[string]any{"id": "local", "values": map[string]string{"model": model}}, nil); err == nil {
			t.Fatal("unreviewed model arguments accepted")
		}
	}
	_, err = ExecuteCommand(t.Context(), s.options.Workspace, s.options.GHExecutable, "gh agent-task create --from-file -", strings.Repeat("😀", 100001), nil)
	statusError(t, err, 400)
}
