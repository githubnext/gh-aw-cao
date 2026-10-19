package localops

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
	copilot "github.com/github/copilot-sdk/go"
)

func TestMain(m *testing.M) {
	if os.Getenv("LOCALOPS_HELPER") == "1" {
		helperProcess()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func helperProcess() {
	args := os.Args[1:]
	joined := strings.Join(args, " ")
	if directory := os.Getenv("LOCALOPS_COMPILER_INSTALL"); directory != "" && len(args) > 1 && (args[0] == "aw" || args[0] == "extension") {
		raw, err := json.Marshal(args)
		if err != nil {
			os.Exit(19)
		}
		file, err := os.OpenFile(filepath.Join(directory, "commands.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600) // #nosec G304 G703 -- trusted parent-provided fixture directory, never browser input.
		if err != nil {
			os.Exit(20)
		}
		_, err = fmt.Fprintln(file, string(raw))
		if errors.Join(err, file.Close()) != nil {
			os.Exit(21)
		}
		if args[0] == "aw" {
			if os.Getenv("LOCALOPS_COMPILER_HOLD") == "1" {
				child := exec.CommandContext(context.Background(), os.Args[0], "--child") // #nosec G204 G702 -- test invokes its own executable.
				child.Stdout, child.Stderr = os.Stdout, os.Stderr
				if child.Start() != nil || os.WriteFile(filepath.Join(directory, "child.pid"), fmt.Appendf(nil, "%d", child.Process.Pid), 0600) != nil { // #nosec G703 -- directory is the trusted test-owned workspace, supplied only by the helper's parent.
					os.Exit(23)
				}
				_ = child.Wait()
				return
			}
			if _, err := os.Stat(filepath.Join(directory, "installed")); err != nil { // #nosec G703 -- trusted parent-provided fixture directory, never browser input.
				os.Exit(1)
			}
			fmt.Print("available")
			return
		}
		if os.Getenv("LOCALOPS_COMPILER_INSTALL_FAIL") == "1" {
			os.Exit(1)
		}
		if os.WriteFile(filepath.Join(directory, "installed"), []byte("ready"), 0600) != nil { // #nosec G703 -- trusted parent-provided fixture directory, never browser input.
			os.Exit(22)
		}
		return
	}
	if os.Getenv("LOCALOPS_CAPTURE_OPERATOR") == "1" && len(args) > 0 && (args[0] == "campaigns" || args[0] == "repos" || args[0] == "cao") {
		raw, err := json.Marshal(args)
		if err != nil {
			os.Exit(17)
		}
		fmt.Println(string(raw))
		return
	}
	if directory := os.Getenv("LOCALOPS_EXPECT_DIRECTORY"); directory != "" && len(args) > 0 && args[0] == "api" {
		cwd, err := os.Getwd()
		if err != nil || cwd != directory || os.Getenv("GH_HOST") != "quota.example.test" || os.Getenv("GH_REPO") != "owner/repo" || len(args) < 4 || args[1] != "--hostname" || args[2] != "quota.example.test" {
			os.Exit(13)
		}
	}
	switch {
	case len(args) > 0 && args[0] == "--child":
		time.Sleep(time.Minute)
	case strings.Contains(joined, "auth token"):
		fmt.Println("test-auth-identity")
	case strings.HasSuffix(joined, "user --jq .id"):
		if os.Getenv("LOCALOPS_QUOTA_BADUSER") == "1" {
			fmt.Print("{}")
			return
		}
		fmt.Println("42")
	case strings.Contains(joined, "api") && strings.HasSuffix(joined, " user"):
		fmt.Print(`{"id":42,"login":"octocat","name":"Octocat","email":null}`)
	case strings.Contains(joined, "rate_limit"):
		if raw := os.Getenv("LOCALOPS_QUOTA_RESPONSE"); raw != "" {
			fmt.Print(raw)
			return
		}
		remaining := 5000
		if os.Getenv("LOCALOPS_QUOTA_EMPTY") == "1" {
			remaining = 1
		}
		fmt.Printf(`{"resources":{"core":{"limit":5000,"remaining":%d,"reset":%d},"graphql":{"limit":5000,"remaining":%d,"reset":%d}}}`, remaining, time.Now().Add(time.Hour).Unix(), remaining, time.Now().Add(time.Hour).Unix())
	case strings.Contains(joined, "/pages --jq .html_url"):
		if os.Getenv("LOCALOPS_PAGES_FAIL") == "1" {
			os.Exit(1)
		}
		value := os.Getenv("LOCALOPS_PAGES_URL")
		if value == "" {
			value = "https://owner.github.io/repo/"
		}
		fmt.Println(value)
	case strings.HasPrefix(joined, "api "):
		mode := os.Getenv("LOCALOPS_GITHUB_MODE")
		if mode == "rate" {
			fmt.Print("HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{}")
			os.Exit(1)
		}
		if mode == "missing" {
			fmt.Print("HTTP/2.0 404 Not Found\r\n\r\n{}")
			os.Exit(1)
		}
		if mode == "oversize" {
			fmt.Print("HTTP/2.0 200 OK\r\n\r\n" + strings.Repeat("x", 600<<10))
			return
		}
		fmt.Print("HTTP/2.0 200 OK\r\nETag: \"upstream\"\r\n\r\n")
		fmt.Print(`{"full_name":"owner/repo","description":null,"html_url":"https://github.com/owner/repo","default_branch":"main","stargazers_count":1,"forks_count":0,"open_issues_count":2,"archived":false,"visibility":"public","token":"must-not-be-cached"}`)
	case strings.HasPrefix(joined, "search repos"):
		if os.Getenv("LOCALOPS_SELECTOR_FAILURE") == "1" {
			fmt.Fprintln(os.Stderr, "private authentication diagnostic")
			os.Exit(1)
		}
		if raw := os.Getenv("LOCALOPS_SELECTOR_RESPONSE"); raw != "" {
			fmt.Print(raw)
			return
		}
		if os.Getenv("LOCALOPS_SELECTOR_CAPTURE") == "1" {
			raw, err := json.Marshal(args)
			if err != nil || os.WriteFile("selector-argv.json", raw, 0600) != nil { // #nosec G703 -- fixed fixture filename; untrusted search stays JSON data, never a path.
				os.Exit(12)
			}
		}
		if os.Getenv("LOCALOPS_SELECTOR_BAD") == "1" {
			fmt.Print(`[{"fullName":42,"description":"bad"}]`)
		} else {
			fmt.Print(`[{"fullName":"owner/repo","description":"Repository"}]`)
		}
	case strings.HasPrefix(joined, "aw terminal") || len(args) > 0 && args[0] == "terminal":
		if os.Getenv("LOCALOPS_EXPECT_IDENTITY") == "1" {
			for _, key := range []string{"GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"} {
				if os.Getenv(key) != "Octocat" {
					os.Exit(14)
				}
			}
			for _, key := range []string{"GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"} {
				if os.Getenv(key) != "42+octocat@users.noreply.github.com" {
					os.Exit(15)
				}
			}
			if os.Getenv("GH_TOKEN") != "reviewed-auth-token" {
				os.Exit(16)
			}
		}
		rows, cols, err := pty.Getsize(os.Stdout)
		if err != nil || rows != 24 || cols != 80 {
			fmt.Fprintln(os.Stderr, "not an 80x24 terminal")
			os.Exit(8)
		}
		if _, _, err = pty.Getsize(os.Stdin); err == nil {
			fmt.Fprintln(os.Stderr, "stdin must not be interactive")
			os.Exit(9)
		}
		input := make([]byte, 1)
		if n, e := os.Stdin.Read(input); n != 0 || e != io.EOF {
			fmt.Fprintln(os.Stderr, "stdin must be closed")
			os.Exit(10)
		}
		if os.Getenv("TERM") != "xterm-256color" || os.Getenv("FORCE_COLOR") != "3" || os.Getenv("NO_COLOR") != "" {
			fmt.Fprintln(os.Stderr, "terminal color environment is invalid")
			os.Exit(11)
		}
		if strings.Contains(joined, "terminal-unicode") {
			_, _ = os.Stdout.Write([]byte{0xe2})
			time.Sleep(20 * time.Millisecond)
			_, _ = os.Stdout.Write([]byte{0x9c, 0x93})
			fmt.Print("\x1b[38;2;1;2;3m" + strings.Repeat("x", 300000) + "\x1b[0m\n")
			os.Exit(7)
		}
		if strings.Contains(joined, "terminal-literal") {
			raw, err := json.Marshal(args[2:])
			if err != nil {
				os.Exit(18)
			}
			fmt.Print(string(raw))
			return
		}
		fmt.Print("\x1b[32mterminal:80x24\x1b[0m\rprogress:1\r")
		time.Sleep(20 * time.Millisecond)
		fmt.Fprint(os.Stderr, "\x1b[31mterminal-stderr\x1b[0m\r")
		if strings.Contains(joined, "terminal-slow") {
			time.Sleep(time.Minute)
		}
		if strings.Contains(joined, "terminal-descendants") {
			command := exec.CommandContext(context.Background(), os.Args[0], "--child") // #nosec G204 G702 -- test recursively invokes only its own executable.
			command.Stdout = os.Stdout
			command.Stderr = os.Stderr
			if command.Start() != nil {
				os.Exit(3)
			}
			fmt.Printf("child:%d\n", command.Process.Pid)
			_ = command.Wait()
		}
		fmt.Print("progress:2\n")
	case strings.HasPrefix(joined, "aw "):
		fmt.Println("local compiler")
	case strings.Contains(joined, "workflow run complete") && os.Getenv("LOCALOPS_ECHO_CREDENTIAL") == "1":
		fmt.Println(os.Getenv("GH_TOKEN"))
	case strings.Contains(joined, "workflow run fail"):
		fmt.Fprintln(os.Stderr, "failed")
		os.Exit(7)
	case strings.Contains(joined, "workflow run slow"):
		fmt.Println("starting")
		time.Sleep(time.Minute)
	case strings.Contains(joined, "workflow run large"):
		fmt.Print(strings.Repeat("x", 2<<20))
		time.Sleep(time.Minute)
	case strings.Contains(joined, "workflow run descendants"):
		command := exec.CommandContext(context.Background(), os.Args[0], "--child") // #nosec G204 G702 -- test recursively invokes only its own executable.
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		if command.Start() != nil {
			os.Exit(3)
		}
		fmt.Printf("child:%d\n", command.Process.Pid)
		_ = command.Wait()
	case strings.Contains(joined, "workflow run output"):
		_, _ = io.WriteString(os.Stdout, "ghp_split")
		time.Sleep(10 * time.Millisecond)
		_, _ = io.WriteString(os.Stdout, "credential\n")
		_, _ = io.WriteString(os.Stdout, "-----BEGIN PRIVATE KEY-----\nprivate body\n-----END PRIVATE KEY-----\n")
		_, _ = fmt.Fprintln(os.Stdout, "https://github.com/owner/repo/pull/31")
		fmt.Fprintln(os.Stderr, "diagnostic")
		_, _ = fmt.Fprintln(os.Stdout, strings.Repeat("x", 20<<10))
	case strings.Contains(joined, "agent-task create"):
		raw, _ := io.ReadAll(os.Stdin)
		fmt.Print(string(raw))
	default:
		fmt.Println("completed")
	}
}
func workspace(t *testing.T) string {
	t.Helper()
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs(".localops-test-" + hex.EncodeToString(random))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return root
}
func fixtureDocument() map[string]any {
	return map[string]any{"dashboard": map[string]any{"cli-actions": []any{
		map[string]any{"id": "complete", "command": "gh workflow run complete"},
		map[string]any{"id": "fail", "command": "gh workflow run fail"},
		map[string]any{"id": "slow", "command": "gh workflow run slow"},
		map[string]any{"id": "output", "command": "gh workflow run output"},
		map[string]any{"id": "descendants", "command": "gh workflow run descendants"},
		map[string]any{"id": "local", "command": "gh aw compile"},
		map[string]any{"id": "copy", "command": "gh aw compile", "copy-only": true},
		map[string]any{"id": "repository", "command": "gh workflow run complete --repo {{repository}} --ref {{cao-repository}}", "arguments": []any{map[string]any{"id": "dry", "flag": "-f dry=true", "default": true}}},
		map[string]any{"id": "task", "command": "gh agent-task create --from-file -"},
	}}}
}
func service(t *testing.T, change func(*Options)) *Service {
	t.Helper()
	t.Setenv("LOCALOPS_HELPER", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	options := Options{Workspace: workspace(t), GHExecutable: executable, OperatorExecutable: executable, Admin: true, Dashboard: fixtureDocument, Timeout: 10 * time.Second}
	if change != nil {
		change(&options)
	}
	s, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}
func call(t *testing.T, s *Service, operation string, payload any) map[string]any {
	t.Helper()
	var value map[string]any
	if err := s.Call(context.Background(), operation, payload, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func enqueue(t *testing.T, s *Service, id string) map[string]any {
	return call(t, s, "queue.enqueue", map[string]any{"body": map[string]any{"id": id}})
}
func waitJob(t *testing.T, s *Service, id any, status string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		value := call(t, s, "queue.detail", map[string]any{"id": id})
		if value["status"] == status {
			return value
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %v did not reach %s: %v", id, status, call(t, s, "queue.detail", map[string]any{"id": id}))
	return nil
}
func statusError(t *testing.T, err error, status int) {
	t.Helper()
	var target *Error
	if !errors.As(err, &target) || target.Status != status {
		t.Fatalf("expected status %d, got %v", status, err)
	}
}

func TestSafeCommandResolution(t *testing.T) {
	for _, command := range []string{"gh aw compile", "./cao.sh dashboard --repo owner/repo", "gh-cao list", "gh workflow run job --repo owner/repo --ref main -f mode=review", "gh agent-task create --from-file -"} {
		if _, err := ParseCommand(command); err != nil {
			t.Errorf("%s: %v", command, err)
		}
	}
	for _, command := range []string{"node activity/cao.mjs", "bash -c dangerous", "gh api user", "gh workflow run job --method DELETE", "gh workflow run --repo owner/repo", "gh workflow run job --repo=-bad/repo", "gh agent-task create --from-file /secrets", "gh aw 'broken", "gh aw compile\nrm bad"} {
		if _, err := ParseCommand(command); err == nil {
			t.Errorf("accepted %q", command)
		}
	}
	doc := fixtureDocument()
	invocation, err := ResolveAction(doc, map[string]any{"id": "repository", "values": map[string]any{"repository": "owner/repo"}}, map[string]string{"cao-repository": "control/repo"})
	if err != nil || invocation.Command != "gh workflow run complete --repo owner/repo --ref control/repo -f dry=true" {
		t.Fatalf("%+v %v", invocation, err)
	}
	for _, payload := range []map[string]any{
		{"id": "repository", "values": map[string]any{"repository": "owner/repo;touch"}},
		{"id": "repository", "values": map[string]any{"repository": "owner/repo", "cao-repository": "attacker/repo"}},
		{"id": "local", "command": "gh aw install"},
		{"id": "local", "arguments": map[string]any{"unknown": true}},
		{"id": "local", "input": "secret"},
		{"id": "copy"}, {"id": "unknown"},
	} {
		if _, err := ResolveAction(doc, payload, nil); err == nil {
			t.Errorf("accepted %+v", payload)
		}
	}
}
func TestCanvasApprovalFailsClosed(t *testing.T) {
	s := service(t, func(o *Options) { o.Canvas = true })
	err := s.Call(context.Background(), "queue.enqueue", map[string]any{"body": map[string]any{"id": "complete"}}, nil)
	statusError(t, err, 403)
	if value := call(t, s, "queue.list", map[string]any{}); value["total"] != float64(0) {
		t.Fatal(value)
	}
	s.options.Approve = func(context.Context, Invocation) (bool, error) {
		return false, errors.New("private trusted-host diagnostic")
	}
	statusError(t, s.Call(t.Context(), "queue.enqueue", map[string]any{"body": map[string]any{"id": "complete"}}, nil), 503)
	s.options.Approve = func(_ context.Context, invocation Invocation) (bool, error) {
		return invocation.ActionID == "complete", nil
	}
	value := enqueue(t, s, "complete")
	waitJob(t, s, value["id"], "completed")
}
func TestDurableQueueOutputIdempotencyAndRetry(t *testing.T) {
	var changed atomic.Int64
	s := service(t, func(o *Options) { o.OnQueueChanged = func() { changed.Add(1) } })
	value := call(t, s, "queue.enqueue", map[string]any{"body": map[string]any{"id": "output", "idempotencyKey": "same"}})
	completed := waitJob(t, s, value["id"], "completed")
	stdout := text(completed["stdout"])
	if strings.Contains(stdout, "splitcredential") || strings.Contains(stdout, "private body") {
		t.Fatal("secret output was persisted")
	}
	if !strings.Contains(stdout, "[REDACTED]") || completed["outputTruncated"] != true || mapping(completed["result"])["pullRequestUrl"] != "https://github.com/owner/repo/pull/31" {
		t.Fatal(completed)
	}
	var chunks []map[string]any
	if err := s.Call(context.Background(), "queue.output", map[string]any{"id": value["id"]}, &chunks); err != nil {
		t.Fatal(err)
	}
	for index, chunk := range chunks {
		if chunk["sequence"] != float64(index+1) {
			t.Fatal(chunks)
		}
	}
	if repeated := call(t, s, "queue.enqueue", map[string]any{"body": map[string]any{"id": "output", "idempotencyKey": "same"}}); repeated["id"] != value["id"] {
		t.Fatal(repeated)
	}
	statusError(t, s.Call(context.Background(), "queue.enqueue", map[string]any{"body": map[string]any{"id": "complete", "idempotencyKey": "same"}}, nil), 409)
	failed := enqueue(t, s, "fail")
	waitJob(t, s, failed["id"], "failed")
	retried := call(t, s, "queue.retry", map[string]any{"id": failed["id"], "body": map[string]any{"idempotencyKey": "retry"}})
	if retried["retryOf"] != failed["id"] {
		t.Fatal(retried)
	}
	waitJob(t, s, retried["id"], "failed")
	list := call(t, s, "queue.list", map[string]any{"status": "failed", "limit": 1, "offset": 0})
	if list["total"] != float64(2) || len(array(list["commands"])) != 1 {
		t.Fatal(list)
	}
	first := mapping(array(list["commands"])[0])
	if _, exists := first["stdout"]; exists {
		t.Fatal("summary leaks output")
	}
	if changed.Load() == 0 {
		t.Fatal("no queue notifications")
	}
	options := s.options
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	persisted := call(t, reopened, "queue.detail", map[string]any{"id": value["id"]})
	if persisted["status"] != "completed" || persisted["stdout"] != completed["stdout"] {
		t.Fatal(persisted)
	}
}
func TestQueueCancellationTimeoutAndDescendants(t *testing.T) {
	s := service(t, func(o *Options) { o.MaxConcurrency = 1; o.Timeout = 300 * time.Millisecond })
	slow := enqueue(t, s, "slow")
	waitJob(t, s, slow["id"], "timed-out")
	s.options.Timeout = 5 * time.Second
	s.queue.options.Timeout = 5 * time.Second
	running := enqueue(t, s, "descendants")
	value := waitJob(t, s, running["id"], "running")
	_ = value
	var child int
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		value = call(t, s, "queue.detail", map[string]any{"id": running["id"]})
		for _, line := range strings.Split(text(value["stdout"]), "\n") {
			if strings.HasPrefix(line, "child:") {
				child, _ = strconv.Atoi(strings.TrimPrefix(line, "child:"))
			}
		}
		if child > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child == 0 {
		t.Fatal("missing child process")
	}
	queued := enqueue(t, s, "complete")
	if queued["status"] != "queued" {
		t.Fatal(queued)
	}
	call(t, s, "queue.cancel", map[string]any{"id": queued["id"]})
	waitJob(t, s, queued["id"], "canceled")
	call(t, s, "queue.cancel", map[string]any{"id": running["id"]})
	waitJob(t, s, running["id"], "canceled")
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if processExited(child) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Some CI init processes retain a killed descendant as a zombie. It must
	// at least no longer be running or holding the queue execution claim.
	for time.Now().Before(deadline.Add(time.Second)) {
		s.queue.mu.Lock()
		count := len(s.queue.active)
		s.queue.mu.Unlock()
		if count == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("canceled descendant did not release its command")
}
func TestQueueRecoveryAndOwnerLock(t *testing.T) {
	s := service(t, nil)
	if _, err := New(s.options); err == nil {
		t.Fatal("second owner acquired queue")
	}
	options := s.options
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", options.QueuePath)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(Invocation{ActionID: "complete", Command: "gh workflow run complete", Arguments: map[string]bool{}, Values: map[string]string{}})
	result, err := db.ExecContext(t.Context(), "INSERT INTO jobs(invocation,fingerprint,status,created_at) VALUES(?,'old','running',?)", string(raw), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	if _, err = db.ExecContext(t.Context(), "INSERT INTO execution_claims VALUES(?)", id); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	reopened, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	detail := call(t, reopened, "queue.detail", map[string]any{"id": id})
	if detail["status"] != "failed" {
		t.Fatal(detail)
	}
	queued := enqueue(t, reopened, "complete")
	time.Sleep(100 * time.Millisecond)
	if detail = call(t, reopened, "queue.detail", map[string]any{"id": queued["id"]}); detail["status"] != "queued" || detail["reason"] != recoveryMessage {
		t.Fatal(detail)
	}
}
func TestQuotaFailsClosedAndLocalBypass(t *testing.T) {
	s := service(t, func(o *Options) { o.MaxConcurrency = 1 })
	t.Setenv("LOCALOPS_QUOTA_EMPTY", "1")
	value := enqueue(t, s, "complete")
	time.Sleep(100 * time.Millisecond)
	if detail := call(t, s, "queue.detail", map[string]any{"id": value["id"]}); detail["status"] != "queued" {
		t.Fatal(detail)
	}
	call(t, s, "queue.cancel", map[string]any{"id": value["id"]})
	local := enqueue(t, s, "local")
	waitJob(t, s, local["id"], "completed")
}
func TestGitHubAllowlistCacheAndBounds(t *testing.T) {
	s := service(t, nil)
	for _, path := range []string{"https://evil.test/repos/a/b", "/api/v1/github/repos/a/../secrets", "/api/v1/github/repos/a/b/actions/secrets", "/api/v1/github/repos/a/b?x=1"} {
		value := call(t, s, "github", map[string]any{"path": path})
		if value["status"] != float64(400) {
			t.Fatal(value)
		}
	}
	path := "/api/v1/github/repos/Owner/Repo"
	value := call(t, s, "github", map[string]any{"path": path})
	if value["status"] != float64(200) || mapping(value["body"])["full_name"] != "owner/repo" {
		t.Fatal(value)
	}
	if _, present := mapping(value["body"])["token"]; present {
		t.Fatal("unexpected upstream field")
	}
	etag := mapping(value["headers"])["ETag"]
	if cached := call(t, s, "github", map[string]any{"path": path, "etag": etag}); cached["status"] != float64(304) {
		t.Fatal(cached)
	}
	t.Setenv("LOCALOPS_GITHUB_MODE", "oversize")
	if oversized := call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/other"}); oversized["status"] != float64(503) {
		t.Fatal(oversized)
	}
	s.github.mu.Lock()
	s.github.blocked = time.Time{}
	s.github.mu.Unlock()
	t.Setenv("LOCALOPS_GITHUB_MODE", "missing")
	if missing := call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/missing"}); missing["status"] != float64(404) {
		t.Fatal(missing)
	}
}

const previewDocument = `{"language-version":"0.1.0","dashboard":{"id":"preview","title":"Preview","queries":[{"name":"recent","from":"runs","limit":10}],"pages":[{"id":"query-preview","kind":"custom","title":"Preview","views":[{"id":"rows","mark":"table","data":{"source":"recent","limit":10},"encoding":{"columns":[{"field":"id","label":"Run"}]}}]}]}}`

func TestCustomViewsValidationPersistenceAndIsolation(t *testing.T) {
	root := workspace(t)
	document, err := ValidateCustomView([]byte(previewDocument))
	if err != nil {
		t.Fatal(err)
	}
	saved, err := SaveCustomView(root, []byte(previewDocument))
	if err != nil {
		t.Fatal(err)
	}
	again, err := SaveCustomView(root, []byte(previewDocument))
	if err != nil || !reflect.DeepEqual(saved, again) {
		t.Fatalf("%v %v", again, err)
	}
	loaded, err := LoadCustomViews(root)
	if err != nil || len(loaded) != 1 {
		t.Fatalf("%v %v", loaded, err)
	}
	materialized := MaterializeCustomView(document, text(saved["id"]))
	dashboard := mapping(materialized["dashboard"])
	page := mapping(array(dashboard["pages"])[0])
	view := mapping(array(page["views"])[0])
	if page["id"] != saved["id"] || mapping(view["data"])["source"] != text(saved["id"])+"-recent" {
		t.Fatal(materialized)
	}
	for _, raw := range []string{
		strings.Replace(previewDocument, `"limit":10`, `"limit":201`, 1),
		strings.Replace(previewDocument, `"source":"recent"`, `"source":"runs"`, 1),
		strings.Replace(previewDocument, `"mark":"table"`, `"mark":"table","element":"terminal"`, 1),
		strings.Replace(previewDocument, `"id":"preview"`, `"id":"preview","cli-actions":[]`, 1),
		strings.Replace(previewDocument, `"id":"query-preview"`, `"id":"query-preview","route":"/danger"`, 1),
	} {
		if _, err := ValidateCustomView([]byte(raw)); err == nil {
			t.Errorf("accepted unsafe document %s", raw)
		}
	}
	root2 := workspace(t)
	if err = os.Symlink(root, filepath.Join(root2, ".cao")); err != nil {
		t.Fatal(err)
	}
	if _, err = SaveCustomView(root2, []byte(previewDocument)); err == nil {
		t.Fatal("saved through symlink")
	}
}
func TestNativeAuthoringContractAndMissingProvider(t *testing.T) {
	s := service(t, func(o *Options) { o.Canvas = true; o.DisableAuthoring = true })
	intent := map[string]any{"intent": "List runs", "subject": "Workflow runs", "acceptance": "Uses available evidence"}
	statusError(t, s.Call(context.Background(), "query.generate", intent, nil), 503)
	s.options.DisableAuthoring = false
	s.options.Author = func(_ context.Context, operation string, payload map[string]any) (any, error) {
		return map[string]any{"document": previewDocument}, nil
	}
	value := call(t, s, "query.generate", intent)
	if value["document"] != previewDocument {
		t.Fatal(value)
	}
	s.options.Author = func(_ context.Context, _ string, _ map[string]any) (any, error) {
		return map[string]any{"intent": "Clear", "subject": "Runs", "objective": "Understand", "acceptance": "Evidence"}, nil
	}
	if value = call(t, s, "query.enhance", map[string]any{"intent": "Runs"}); len(value) != 4 {
		t.Fatal(value)
	}
	config := nativeSessionConfig(s.options.Workspace, "system")
	if config.AvailableTools == nil || len(config.AvailableTools) != 0 || config.EnableConfigDiscovery == nil || *config.EnableConfigDiscovery || len(config.MCPServers) != 0 {
		t.Fatal("SDK tool sandbox not fail-closed")
	}
	decision, err := config.OnPermissionRequest(nil, copilot.PermissionInvocation{})
	if err != nil || decision.Kind() != "reject" {
		t.Fatalf("%v %v", decision, err)
	}
}

func TestSelectorAndRuntimeSources(t *testing.T) {
	s := service(t, nil)
	document := fixtureDocument()
	action := actionByID(document, "repository")
	action["selector"] = map[string]any{
		"label": "Repository", "debounce-ms": 300,
		"query":   map[string]any{"command": "gh search repos", "fields": []any{"fullName", "description"}, "limit": 10},
		"mapping": map[string]any{"value": "fullName", "label": "fullName", "description": "description", "target": "repository"},
	}
	s.options.Dashboard = func() map[string]any { return document }
	value := call(t, s, "selector", map[string]any{"id": "repository", "text": "owner"})
	if len(array(value["options"])) != 1 || mapping(array(value["options"])[0])["value"] != "owner/repo" {
		t.Fatal(value)
	}
	statusError(t, s.Call(context.Background(), "selector", map[string]any{"id": "repository", "text": "ow\nner"}, nil), 400)
	t.Setenv("LOCALOPS_SELECTOR_BAD", "1")
	statusError(t, s.Call(context.Background(), "selector", map[string]any{"id": "repository", "text": "owner"}, nil), 502)
	job := enqueue(t, s, "complete")
	waitJob(t, s, job["id"], "completed")
	sources := call(t, s, "queue.sources", map[string]any{})
	if len(sources) != 3 || len(array(mapping(sources["cli-command-statuses"])["rows"])) != 6 {
		t.Fatal(sources)
	}
	commands := mapping(sources["cli-commands"])
	rows := array(commands["rows"])
	if len(rows) != 1 {
		t.Fatal(commands)
	}
	if _, err := time.Parse(time.RFC3339Nano, text(mapping(rows[0])["createdAt"])); err != nil {
		t.Fatal(err)
	}
}
func TestInvocationSecretsBoundsAndWorkspaceIsolation(t *testing.T) {
	s := service(t, nil)
	for _, payload := range []map[string]any{
		{"id": "task", "input": "token=do-not-persist"},
		{"id": "task", "input": "ghp_testcredential"},
		{"id": "task", "input": strings.Repeat("x", 100001)},
	} {
		statusError(t, s.Call(context.Background(), "queue.enqueue", map[string]any{"body": payload}, nil), 400)
	}
	if value := call(t, s, "queue.list", map[string]any{}); value["total"] != float64(0) {
		t.Fatal(value)
	}
	options := s.options
	options.QueuePath = filepath.Join(filepath.Dir(options.Workspace), "outside.sqlite")
	if _, err := New(options); err == nil {
		t.Fatal("queue escaped workspace")
	}
	path := filepath.Join(s.options.Workspace, "linked")
	if err := os.Symlink(filepath.Join(s.options.Workspace, ".cao"), path); err != nil {
		t.Fatal(err)
	}
	options.QueuePath = filepath.Join(path, "other.sqlite")
	if _, err := New(options); err == nil {
		t.Fatal("queue traversed symlink")
	}
}
func TestRecoveryAcknowledgmentAllowsStarts(t *testing.T) {
	s := service(t, nil)
	options := s.options
	_ = s.Close()
	db, err := sql.Open("sqlite", options.QueuePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), "INSERT INTO queue_state VALUES('recovery_blocked',?)", recoveryMessage); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	options.AcknowledgeRecovery = true
	restarted, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restarted.Close() }()
	job := enqueue(t, restarted, "complete")
	waitJob(t, restarted, job["id"], "completed")
}
func TestRetryDeclarationChangesFailClosed(t *testing.T) {
	s := service(t, nil)
	job := enqueue(t, s, "fail")
	waitJob(t, s, job["id"], "failed")
	document := fixtureDocument()
	actionByID(document, "fail")["command"] = "gh workflow run complete"
	s.options.Dashboard = func() map[string]any { return document }
	statusError(t, s.Call(context.Background(), "queue.retry", map[string]any{"id": job["id"]}, nil), 409)
}
func TestGeneratedDocumentCapabilitiesCannotBeSaved(t *testing.T) {
	s := service(t, func(o *Options) {
		o.Canvas = true
		o.Author = func(context.Context, string, map[string]any) (any, error) {
			return map[string]any{"document": strings.Replace(previewDocument, `"mark":"table"`, `"mark":"table","element":"terminal"`, 1)}, nil
		}
	})
	candidate := call(t, s, "query.generate", map[string]any{"intent": "Run arbitrary code", "subject": "Runs", "acceptance": "Evidence"})
	statusError(t, s.Call(t.Context(), "views.save", map[string]any{"document": candidate["document"]}, nil), 400)
}
