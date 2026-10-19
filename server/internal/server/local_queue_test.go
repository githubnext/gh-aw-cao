package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/localops"
)

func nativeQueueServer(t *testing.T, approve func(context.Context, localops.Invocation) (bool, error), inspect ...func(map[string]any)) (*LocalServer, *httptest.Server) {
	t.Helper()
	local, server := localTestServer(t)
	server.Client().Timeout = 5 * time.Second
	gh := filepath.Join(local.config.Workspace, "fake-gh")
	script := `#!/bin/sh
printf '%s\n' "$*" >> fake-gh.calls
if [ "$1" = api ] && [ "$2" = --hostname ]; then
  shift 3
  set -- api "$@"
fi
case "$1 $2" in
  "auth status") exit 0;;
  "auth token") printf 'fixture-token';;
  "api user") if [ "$3" = --jq ]; then printf 1; else printf '{"login":"fixture","id":1}'; fi;;
  "api rate_limit"|"api /rate_limit") printf '{"resources":{"core":{"limit":5000,"remaining":5000,"reset":%s},"graphql":{"limit":5000,"remaining":5000,"reset":%s},"search":{"limit":30,"remaining":30,"reset":%s}}}' "$(( $(date +%s) + 3600 ))" "$(( $(date +%s) + 3600 ))" "$(( $(date +%s) + 60 ))";;
  "workflow run")
    printf 'starting\n'
    case "$3" in
      slow.yml) sleep 1;;
      failed.yml) printf 'failure\n' >&2; exit 2;;
      unicode.yml) printf '\342'; sleep 0.05; printf '\202\254\n';;
      secret.yml) printf 'ghp_AAAAAAAAAAAAAAAA'; sleep 0.05; printf 'AAAAAAAAAAAAAAAA\n';;
    esac
    printf 'https://github.com/acme/control/pull/42\n';;
  *) exit 1;;
esac
`
	if err := os.WriteFile(gh, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(gh, 0o700); err != nil { // #nosec G302 -- This trusted temporary fixture must be executable.
		t.Fatal(err)
	}
	document := map[string]any{"dashboard": map[string]any{"cli-actions": []any{
		map[string]any{"id": "dispatch", "command": "gh workflow run success.yml --repo acme/control"},
		map[string]any{"id": "slow", "command": "gh workflow run slow.yml --repo acme/control"},
		map[string]any{"id": "failed", "command": "gh workflow run failed.yml --repo acme/control"},
		map[string]any{"id": "unicode", "command": "gh workflow run unicode.yml --repo acme/control"},
		map[string]any{"id": "secret", "command": "gh workflow run secret.yml --repo acme/control"},
		map[string]any{"id": "task", "command": "gh agent-task create --from-file -"},
		map[string]any{"id": "copy", "command": "gh workflow run success.yml --repo acme/control", "copy-only": true},
	}}}
	for _, callback := range inspect {
		callback(document)
	}
	operations, err := localops.New(localops.Options{
		Workspace: local.config.Workspace, GHExecutable: gh, Canvas: true,
		Dashboard: func() map[string]any { return document }, Approve: approve,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		server.Close()
		if err := operations.Close(); err != nil {
			t.Error(err)
		}
		if t.Failed() {
			content, err := os.ReadFile(filepath.Join(local.config.Workspace, "fake-gh.calls"))
			if err == nil {
				t.Logf("fixture GitHub CLI invocations: %s", content)
			}
		}
	})
	local.config.Queue = true
	local.SetOperations(operations)
	return local, server
}

func queueRequest(t *testing.T, local *LocalServer, server *httptest.Server, method, path, body, key string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, server.URL+local.config.Prefix+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", server.URL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, content
}

func TestLocalNativeQueueStreamsRunningStatus(t *testing.T) {
	local, server := nativeQueueServer(t, func(context.Context, localops.Invocation) (bool, error) {
		return true, nil
	})
	status, body := queueRequest(t, local, server, http.MethodPost, "/__cli_commands", `{"id":"slow"}`, "")
	if status != http.StatusAccepted {
		t.Fatalf("enqueue: %d %s", status, body)
	}
	var command map[string]any
	if err := json.Unmarshal(body, &command); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		server.URL+local.config.Prefix+"/__cli_commands/"+fmt.Sprint(command["id"])+"/output", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	scanner := bufio.NewScanner(response.Body)
	running := false
	for scanner.Scan() {
		var event struct {
			Type    string `json:"type"`
			Command struct {
				Status string `json:"status"`
			} `json:"command"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "status" && event.Command.Status == "running" {
			running = true
		}
		if event.Type == "complete" {
			if !running || event.Command.Status != "completed" {
				t.Fatalf("command completed without live running status: running=%v, status=%s", running, event.Command.Status)
			}
			return
		}
	}
	t.Fatalf("command stream ended before completion: %v", scanner.Err())
}

func TestLocalNativeQueueAdmissionAndOutput(t *testing.T) {
	var approvals atomic.Int64
	local, server := nativeQueueServer(t, func(_ context.Context, invocation localops.Invocation) (bool, error) {
		approvals.Add(1)
		if invocation.Command != "gh workflow run success.yml --repo acme/control" {
			t.Errorf("approval command %q", invocation.Command)
		}
		return true, nil
	})
	status, body := queueRequest(t, local, server, "POST", "/__cli_commands", `{"id":"dispatch"}`, "same-request")
	if status != 202 {
		t.Fatalf("enqueue: %d %s", status, body)
	}
	var command map[string]any
	if err := json.Unmarshal(body, &command); err != nil {
		t.Fatal(err)
	}
	id := fmt.Sprint(command["id"])
	if id == "" || id == "<nil>" {
		t.Fatalf("missing persistent id: %s", body)
	}
	status, duplicate := queueRequest(t, local, server, "POST", "/__cli_commands", `{"id":"dispatch"}`, "same-request")
	var repeated map[string]any
	if err := json.Unmarshal(duplicate, &repeated); err != nil {
		t.Fatal(err)
	}
	if status != 202 || fmt.Sprint(repeated["id"]) != id {
		t.Fatalf("idempotent enqueue: %d %s", status, duplicate)
	}
	status, output := queueRequest(t, local, server, "GET", "/__cli_commands/"+id+"/output", "", "")
	if status != 200 || !bytes.Contains(output, []byte(`"type":"output"`)) || !bytes.Contains(output, []byte(`"type":"complete"`)) {
		t.Fatalf("native output stream: %d %s", status, output)
	}
	if !bytes.Contains(output, []byte(`"pullRequestUrl":"https://github.com/acme/control/pull/42"`)) {
		t.Fatalf("missing durable result: %s", output)
	}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	var last int64
	for scanner.Scan() {
		var event struct {
			Type     string `json:"type"`
			Sequence int64  `json:"sequence"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "output" {
			if event.Sequence <= last {
				t.Fatal("output cursor did not advance")
			}
			last = event.Sequence
		}
	}
	status, history := queueRequest(t, local, server, "GET", "/__cli_commands?limit=10&offset=0", "", "")
	if status != 200 || bytes.Contains(history, []byte(`"input":`)) || bytes.Contains(history, []byte(`"stdout":`)) {
		t.Fatalf("bounded history: %d %s", status, history)
	}
	if approvals.Load() == 0 {
		t.Fatal("execution bypassed trusted approval")
	}
}

func TestLocalNativeQueueRejectsUndeclaredOverridesAndInvalidPagination(t *testing.T) {
	local, server := nativeQueueServer(t, func(context.Context, localops.Invocation) (bool, error) { return true, nil })
	for _, test := range []struct {
		body string
		want int
	}{
		{`{"id":"missing"}`, 404},
		{`{"id":"copy"}`, 403},
		{`{"id":"dispatch","command":"sh -c whoami"}`, 400},
		{`{"id":"dispatch","arguments":{"unsafe":true}}`, 400},
		{`{"id":"dispatch","input":"unexpected"}`, 400},
	} {
		status, body := queueRequest(t, local, server, "POST", "/__cli_commands", test.body, "")
		if status != test.want {
			t.Errorf("%s: %d %s, want %d", test.body, status, body, test.want)
		}
	}
	for _, query := range []string{"limit=-1", "limit=301", "limit=1.5", "offset=01", "offset=-1"} {
		status, body := queueRequest(t, local, server, "GET", "/__cli_commands?"+query, "", "")
		if status != 400 {
			t.Errorf("%s: %d %s", query, status, body)
		}
	}
	for _, suffix := range []string{"", "/output", "/cancel", "/retry"} {
		method := "GET"
		if suffix == "/cancel" || suffix == "/retry" {
			method = "POST"
		}
		status, body := queueRequest(t, local, server, method, "/__cli_commands/999999"+suffix, `{}`, "")
		if status != 404 {
			t.Errorf("missing%s: %d %s", suffix, status, body)
		}
	}
}

func TestLocalNativeQueueApprovalDenial(t *testing.T) {
	for _, approve := range []func(context.Context, localops.Invocation) (bool, error){
		nil, func(context.Context, localops.Invocation) (bool, error) { return false, nil },
	} {
		local, server := nativeQueueServer(t, approve)
		status, body := queueRequest(t, local, server, "POST", "/__cli_commands", `{"id":"dispatch"}`, "")
		if status != 403 {
			t.Fatalf("unapproved native execution: %d %s", status, body)
		}
	}
}

func TestLocalNativeQueuePreservesMaximumEscapedApprovalInput(t *testing.T) {
	input := strings.Repeat("\x00", 100000)
	local, server := nativeQueueServer(t, func(_ context.Context, invocation localops.Invocation) (bool, error) {
		if invocation.Input == nil || *invocation.Input != input {
			t.Error("trusted approval input was changed or truncated")
		}
		return false, nil
	})
	payload, err := json.Marshal(map[string]any{"id": "task", "input": input})
	if err != nil {
		t.Fatal(err)
	}
	status, body := queueRequest(t, local, server, "POST", "/__cli_commands", string(payload), "")
	if status != 403 {
		t.Fatalf("maximum escaped input: %d %s", status, body)
	}
}

func TestLocalNativeQueueRetryRevalidatesDeclarationAndIdempotency(t *testing.T) {
	var document map[string]any
	local, server := nativeQueueServer(t,
		func(context.Context, localops.Invocation) (bool, error) { return true, nil },
		func(value map[string]any) { document = value },
	)
	status, body := queueRequest(t, local, server, "POST", "/__cli_commands", `{"id":"failed"}`, "original")
	var original struct {
		ID int64 `json:"id"`
	}
	if status != 202 || json.Unmarshal(body, &original) != nil || original.ID == 0 {
		t.Fatalf("enqueue: %d %s", status, body)
	}
	endpoint := fmt.Sprintf("/__cli_commands/%d", original.ID)
	status, body = queueRequest(t, local, server, "GET", endpoint+"/output", "", "")
	if status != 200 || !bytes.Contains(body, []byte(`"ok":false`)) {
		t.Fatalf("failed command output: %d %s", status, body)
	}
	status, body = queueRequest(t, local, server, "POST", endpoint+"/retry", `{}`, "original")
	if status != 409 {
		t.Fatalf("retry reused original enqueue key: %d %s", status, body)
	}
	status, body = queueRequest(t, local, server, "POST", endpoint+"/retry", `{}`, "retry")
	var retried struct {
		ID int64 `json:"id"`
	}
	if status != 202 || json.Unmarshal(body, &retried) != nil || retried.ID <= original.ID {
		t.Fatalf("retry did not create a new durable command: %d %s", status, body)
	}
	status, body = queueRequest(t, local, server, "POST", endpoint+"/retry", `{}`, "retry")
	var repeated struct {
		ID int64 `json:"id"`
	}
	if status != 202 || json.Unmarshal(body, &repeated) != nil || repeated.ID != retried.ID {
		t.Fatalf("retry was not idempotent: %d %s", status, body)
	}
	_, _ = queueRequest(t, local, server, "GET", fmt.Sprintf("/__cli_commands/%d/output", retried.ID), "", "")
	actions := document["dashboard"].(map[string]any)["cli-actions"].([]any)
	for _, entry := range actions {
		action := entry.(map[string]any)
		if action["id"] == "failed" {
			action["command"] = "gh workflow run failed.yml --repo acme/changed"
		}
	}
	status, body = queueRequest(t, local, server, "POST", endpoint+"/retry", `{}`, "changed")
	if status != 409 {
		t.Fatalf("retry accepted a changed declaration: %d %s", status, body)
	}
}

func TestLocalNativeOutputDisconnectDoesNotCancelCommand(t *testing.T) {
	local, server := nativeQueueServer(t, func(context.Context, localops.Invocation) (bool, error) { return true, nil })
	status, body := queueRequest(t, local, server, "POST", "/__cli_commands", `{"id":"slow"}`, "")
	if status != 202 {
		t.Fatalf("enqueue: %d %s", status, body)
	}
	var command struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(body, &command); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	id := fmt.Sprint(command.ID)
	request, err := http.NewRequestWithContext(ctx, "GET", server.URL+local.config.Prefix+"/__cli_commands/"+id+"/output", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	_ = response.Body.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, body = queueRequest(t, local, server, "GET", "/__cli_commands/"+id, "", "")
		if status == 200 && bytes.Contains(body, []byte(`"status":"completed"`)) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("detached execution did not complete: %d %s", status, body)
}

func TestLocalNativeQueuePreservesSplitUnicodeAndRedactsSplitSecrets(t *testing.T) {
	local, server := nativeQueueServer(t, func(context.Context, localops.Invocation) (bool, error) { return true, nil })
	for _, action := range []string{"unicode", "secret"} {
		status, content := queueRequest(t, local, server, "POST", "/__cli_commands", `{"id":"`+action+`"}`, "")
		if status != 202 {
			t.Fatalf("%s enqueue: %d", action, status)
		}
		var command struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(content, &command); err != nil {
			t.Fatal(err)
		}
		status, output := queueRequest(t, local, server, "GET", fmt.Sprintf("/__cli_commands/%d/output", command.ID), "", "")
		if status != 200 || !bytes.Contains(output, []byte(`"type":"complete"`)) {
			t.Fatalf("%s output did not complete", action)
		}
		if action == "unicode" && !bytes.Contains(output, []byte("\u20ac")) {
			t.Fatal("split UTF-8 output was corrupted")
		}
		if action == "secret" && (bytes.Contains(output, []byte("ghp_")) || !bytes.Contains(output, []byte("[REDACTED]"))) {
			t.Fatal("split secret output was not redacted")
		}
	}
}
