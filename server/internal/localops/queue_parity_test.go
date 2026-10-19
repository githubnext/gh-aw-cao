package localops

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/dashboard"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

func abundantQuota(_ context.Context, resources []string) (quotaSnapshot, error) {
	result := quotaSnapshot{"queue-parity", map[string]githubquota.Observation{}}
	for _, resource := range resources {
		result.observations[resource] = githubquota.Observation{Limit: 50000, Remaining: 50000, ResetAt: time.Now().Add(time.Hour)}
	}
	return result, nil
}

func TestQueueThreeHundredFIFOClaimsConcurrencyAndPersistentIDs(t *testing.T) {
	t.Setenv("GH_TOKEN", "queue-parity-auth")
	s := service(t, func(o *Options) { o.MaxConcurrency = 5 })
	s.queue.admission.read = abundantQuota
	ctx := t.Context()
	for index := range 300 {
		invocation := Invocation{ActionID: fmt.Sprintf("action-%03d", index), Command: fmt.Sprintf("gh workflow run fifo-%03d", index)}
		row, err := s.queue.enqueue(ctx, invocation, fmt.Sprintf("key-%03d", index), nil)
		if err != nil || row["id"] != int64(index+1) {
			t.Fatalf("persistent enqueue %d: %v %v", index, row, err)
		}
	}
	first := Invocation{ActionID: "action-000", Command: "gh workflow run fifo-000"}
	row, err := s.queue.enqueue(ctx, first, "key-000", nil)
	if err != nil || row["id"] != int64(1) {
		t.Fatal(row, err)
	}
	statusError(t, func() error {
		_, err := s.queue.enqueue(ctx, Invocation{ActionID: "different", Command: "gh workflow run fifo-000"}, "key-000", nil)
		return err
	}(), 409)
	deadline, maximum := time.Now().Add(150*time.Second), 0
	for {
		s.queue.mu.Lock()
		active := len(s.queue.active)
		maximum = max(maximum, active)
		var completed int
		err = s.queue.db.QueryRowContext(ctx, "SELECT count(*) FROM jobs WHERE status='completed'").Scan(&completed)
		s.queue.mu.Unlock()
		if err != nil || active > 5 {
			t.Fatalf("bounded concurrency: %d, %v", active, err)
		}
		if completed == 300 && active == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/300 commands completed", completed)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if maximum < 2 {
		t.Fatal("queue did not execute concurrently")
	}
	rows, err := s.queue.db.QueryContext(ctx, "SELECT id,started_at FROM jobs ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	previous := int64(0)
	for rows.Next() {
		var id, started int64
		if err = rows.Scan(&id, &started); err != nil {
			t.Fatal(err)
		}
		if started < previous {
			t.Fatalf("FIFO claim order changed at job %d", id)
		}
		previous = started
	}
	if err = errors.Join(rows.Err(), rows.Close()); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	row, err = reopened.queue.enqueue(ctx, first, "key-000", nil)
	if err != nil || row["id"] != int64(1) {
		t.Fatal(row, err)
	}
	row, err = reopened.queue.enqueue(ctx, Invocation{ActionID: "next", Command: "gh workflow run next"}, nil, nil)
	if err != nil || row["id"] != int64(301) {
		t.Fatal(row, err)
	}
}

func TestQueueEnterprisePRsBackfillRetainedOutputAndPreserveNoURLShape(t *testing.T) {
	s := service(t, nil)
	ctx := t.Context()
	q := s.queue
	raw, err := json.Marshal(Invocation{ActionID: "output", Command: "gh workflow run output"})
	if err != nil {
		t.Fatal(err)
	}
	inserted, err := q.db.ExecContext(ctx, "INSERT INTO jobs(invocation,fingerprint,status,created_at) VALUES(?,'seed','running',?)", string(raw), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	id, err := inserted.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	for range 5 {
		if err = q.append(ctx, id, "stdout", strings.Repeat("x", 16<<10)); err != nil {
			t.Fatal(err)
		}
	}
	frames := newOutputFrames(func(stream, data string) error { return q.append(ctx, id, stream, data) }, func() {})
	for _, chunk := range []string{
		"https://github.com/octo/repo/pull/1\n",
		"\x1b[32mhttps://ghe.example.test:8443/github/team/",
		"project/pull/42\x1b[0m\n",
		"******ghe.example.test/team/project/pull/99\n",
		"https://ghe.example.test/team/project/issues/100\n",
	} {
		if err = frames.write("stderr", chunk); err != nil {
			t.Fatal(err)
		}
	}
	frames.flush()
	q.mu.Lock()
	err = q.finishLocked(ctx, id, "completed", 0, "")
	q.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	expected := "https://ghe.example.test:8443/github/team/project/pull/42"
	detail, err := q.detail(ctx, id)
	if err != nil || mapping(detail["result"])["pullRequestUrl"] != expected || strings.Contains(text(detail["stdout"]), expected) {
		t.Fatal("PR metadata must not depend on the bounded transcript preview", err)
	}
	plain := enqueue(t, s, "complete")
	if result := mapping(waitJob(t, s, plain["id"], "completed")["result"]); len(result) != 2 || result["ok"] != true || result["exitCode"] != float64(0) {
		t.Fatal("commands without PRs changed result shape", result)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", s.options.QueuePath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, "ALTER TABLE jobs DROP COLUMN pull_request_url")
	if err = errors.Join(err, db.Close()); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	detail = call(t, reopened, "queue.detail", map[string]any{"id": id})
	if mapping(detail["result"])["pullRequestUrl"] != expected {
		t.Fatal("legacy queue migration did not backfill the final enterprise PR URL", detail)
	}
	for _, value := range []string{
		"https://user:pass@ghe.example.test/team/project/pull/99",
		"https://ghe.example.test/team/project/pull/42evil",
		"http://ghe.example.test/team/project/pull/42",
		"https://ghe.example.test/team/project/issues/42",
	} {
		if lastPullRequestURL(value) != "" {
			t.Errorf("unsafe or non-PR result URL: %q", value)
		}
	}
}

func TestQueueMaximumEscapedInputBooleanMappingsAndRetryPersist(t *testing.T) {
	s := service(t, func(o *Options) { o.Repository = "control/repo" })
	s.queue.admission.read = func(context.Context, []string) (quotaSnapshot, error) {
		return quotaSnapshot{}, errors.New("fixture blocks remote actions")
	}
	document := fixtureDocument()
	for _, action := range array(mapping(document["dashboard"])["cli-actions"]) {
		if mapping(action)["id"] == "repository" {
			mapping(action)["arguments"] = []any{
				map[string]any{"id": "dry", "flag": "-f dry=true", "default": false},
				map[string]any{"id": "optional", "flag": "-f optional=true", "default": false},
			}
		}
	}
	s.options.Dashboard = func() map[string]any { return document }
	input := strings.Repeat("\x01", 100000)
	requests := []map[string]any{
		{"id": "task", "input": input},
		{"id": "repository", "arguments": map[string]any{"dry": true, "optional": false}, "values": map[string]any{"repository": "owner/repo"}},
	}
	retries := make([]any, 0, len(requests))
	for index, request := range requests {
		original := call(t, s, "queue.enqueue", map[string]any{"body": request})
		s.queue.mu.Lock()
		err := s.queue.finishLocked(t.Context(), int64(original["id"].(float64)), "failed", 1, "fixture failure")
		s.queue.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		retried := call(t, s, "queue.retry", map[string]any{"id": original["id"], "body": map[string]any{"idempotencyKey": fmt.Sprintf("retry-%d", index)}})
		if !reflect.DeepEqual(retried["arguments"], original["arguments"]) || retried["input"] != original["input"] {
			t.Fatal("retry changed the approved boolean mapping or prompt")
		}
		retries = append(retries, retried["id"])
	}
	statusError(t, s.Call(t.Context(), "queue.enqueue", map[string]any{"body": map[string]any{"id": "task", "input": input + "x"}}, nil), 400)
	statusError(t, s.Call(t.Context(), "queue.enqueue", map[string]any{"body": map[string]any{"id": "repository", "arguments": []any{"dry"}}}, nil), 400)
	s.queue.mu.Lock()
	_, err := s.queue.db.ExecContext(t.Context(), "INSERT OR REPLACE INTO queue_state VALUES('recovery_blocked',?)", recoveryMessage)
	s.queue.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	if detail := call(t, reopened, "queue.detail", map[string]any{"id": retries[0]}); detail["input"] != input {
		t.Fatal("maximum escaped prompt changed across restart")
	}
	if detail := call(t, reopened, "queue.detail", map[string]any{"id": retries[1]}); !reflect.DeepEqual(detail["arguments"], map[string]any{"dry": true, "optional": false}) {
		t.Fatal("boolean mapping changed across restart")
	}
}

func TestQueueAllDatabaseSidecarsRejectLinksWithoutTouchingTargets(t *testing.T) {
	root := workspace(t)
	target := filepath.Join(root, "unrelated")
	if err := os.WriteFile(target, []byte("must remain untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	queueDirectory := filepath.Join(root, "queue")
	if err := os.Mkdir(queueDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(queueDirectory, "commands.sqlite")
	for _, base := range []string{path, path + ".owner.sqlite"} {
		for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
			for name, link := range map[string]func(string, string) error{"symlink": os.Symlink, "hardlink": os.Link} {
				t.Run(filepath.Base(base)+suffix+"/"+name, func(t *testing.T) {
					candidate := base + suffix
					if err := link(target, candidate); err != nil {
						t.Skipf("link primitive unavailable: %v", err)
					}
					t.Cleanup(func() { _ = os.Remove(candidate) })
					q, err := newQueue(Options{Workspace: root, QueuePath: path, MaxConcurrency: 1})
					if err == nil {
						_ = q.close()
						t.Fatal("queue followed a symbolic or multiply-linked sidecar")
					}
					raw, err := os.ReadFile(target) // #nosec G304 -- target is this test's owned sentinel file.
					if err != nil || string(raw) != "must remain untouched" {
						t.Fatal("queue touched an unrelated link target", err)
					}
				})
			}
		}
	}
}

func TestBuiltinUpdateAndUpgradeAttributionIsOneArgument(t *testing.T) {
	raw, err := dashboard.Catalog.ReadFile("site/dashboard.json")
	if err != nil {
		t.Fatal(err)
	}

	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	context := map[string]string{"cao-repository": "acme/control", "cao-repository-url": "https://github.com/acme/control", "cao-url": "https://ops.example.com/central/"}
	for _, id := range []string{"update-repository", "update-campaign", "upgrade-repository", "upgrade-target-repository"} {
		update := strings.HasPrefix(id, "update")
		values := map[string]any{"repository": "octo/example"}
		if update {
			values = map[string]any{"campaign": "activity"}
		}
		for _, createPR := range []bool{false, true} {
			invocation, err := ResolveAction(document, map[string]any{"id": id, "values": values, "arguments": map[string]any{"create-pull-request": createPR}}, context)
			if err != nil {
				t.Fatal(id, err)
			}
			tokens, err := ParseCommand(invocation.Command)
			if err != nil {
				t.Fatal(err)
			}
			message := ""
			for index, token := range tokens {
				if token == "--pr-message" && index+1 < len(tokens) {
					message = tokens[index+1]
				}
			}
			if !strings.Contains(message, "[Central Agentic Ops (CAO)](https://github.com/acme/control)") || !strings.Contains(message, "[CAO dashboard](https://ops.example.com/central/#page-maintenance") {
				t.Fatalf("%s attribution was split or host context changed: %q", id, tokens)
			}
			if strings.Contains(strings.Join(tokens, "\x00"), "--create-pull-request") != createPR {
				t.Fatal("PR boolean argument mapping changed")
			}
		}
	}
}

func TestQueueRecoveryKeepsCanceledClaimsBlockedAcrossRepeatedRestart(t *testing.T) {
	s := service(t, nil)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", s.options.QueuePath)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(Invocation{ActionID: "complete", Command: "gh workflow run complete"})
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"canceled", "queued"} {
		if _, err = db.ExecContext(t.Context(), "INSERT INTO jobs(invocation,fingerprint,status,created_at) VALUES(?,'seed',?,?)", string(raw), status, time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.ExecContext(t.Context(), "INSERT INTO execution_claims VALUES(1)"); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		reopened, err := New(s.options)
		if err != nil {
			t.Fatal(err)
		}
		for id, status := range map[int]string{1: "canceled", 2: "queued"} {
			if detail := call(t, reopened, "queue.detail", map[string]any{"id": id}); detail["status"] != status {
				t.Fatal("recovery changed a canceled claim or started unverified work", detail)
			}
		}
		if list := call(t, reopened, "queue.list", map[string]any{}); list["pausedReason"] != recoveryMessage {
			t.Fatal("recovery uncertainty was not durable", list)
		}
		if err = reopened.Close(); err != nil {
			t.Fatal(err)
		}
	}
	options := s.options
	options.AcknowledgeRecovery = true
	reconciled, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reconciled.Close() }()
	waitJob(t, reconciled, 2, "completed")
	if detail := call(t, reconciled, "queue.detail", map[string]any{"id": 1}); detail["status"] != "canceled" {
		t.Fatal("operator reconciliation reran a canceled command")
	}
}

func TestNativeCommandParsingQuotedArgumentsAndFileInputRejection(t *testing.T) {
	command := "gh aw compile --strict --name 'Release check'"
	tokens, err := ParseCommand(command)
	if err != nil || !reflect.DeepEqual(tokens, []string{"gh", "aw", "compile", "--strict", "--name", "Release check"}) {
		t.Fatal(tokens, err)
	}
	for _, command := range []string{
		`gh workflow run ""`, "gh workflow view", "gh cao", "gh caox add repository",
		"gh workflow run job -F token=@/proc/self/environ", "gh workflow run job --json",
		"gh agent-task create -F -", "gh agent-task create prompt", "gh agent-task create --from-file private-file",
	} {
		if _, err := ParseCommand(command); err == nil {
			t.Errorf("unsupported or file-backed command accepted: %s", command)
		}
	}
	tokens, err = ParseCommand("gh workflow run maintenance.yml -R octo/example --ref main -f mode=review --raw-field=count=2")
	if err != nil || !reflect.DeepEqual(tokens, []string{"gh", "workflow", "run", "maintenance.yml", "-R", "octo/example", "--ref", "main", "-f", "mode=review", "--raw-field=count=2"}) {
		t.Fatal(tokens, err)
	}
}

func TestNativePublicExecutorBoundsOutputAndPreservesFailureMetadata(t *testing.T) {
	s := service(t, nil)
	var stdout, stderr strings.Builder
	output := func(stream, data string) {
		if stream == "stderr" {
			stderr.WriteString(data)
		} else {
			stdout.WriteString(data)
		}
	}
	result, err := ExecuteCommand(t.Context(), s.options.Workspace, s.options.GHExecutable, "gh workflow run fail", "", output)
	if err != nil || result["ok"] != false || result["exitCode"] != 7 || stderr.String() != "failed\n" {
		t.Fatal(result, err, stderr.String())
	}
	result, err = ExecuteCommand(t.Context(), s.options.Workspace, s.options.GHExecutable, "gh workflow run large", "", output)
	if err == nil || result["ok"] != false || stdout.Len() > 1<<20 {
		t.Fatal("public executor lost its output bound", result, err, stdout.Len())
	}
}
