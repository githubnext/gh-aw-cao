package redisx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

type manyIssueClient struct {
	keys     []any
	payloads map[string]string
	lookups  [][]string
}

func (c *manyIssueClient) Do(_ context.Context, command ...string) (any, error) {
	switch command[0] {
	case "HGET":
		return `{"availability":"available"}`, nil
	case "EVAL":
		out := []any{"_staged", "1"}
		for _, key := range c.keys {
			out = append(out, key, c.payloads[fmt.Sprint(key)])
		}
		return []any{"0", out}, nil
	case "HMGET":
		c.lookups = append(c.lookups, append([]string(nil), command...))
		return make([]any, len(command)-2), nil
	}
	return nil, fmt.Errorf("unexpected command %s", command[0])
}

func (*manyIssueClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }

func TestLoadIssuesOnlyLooksUpRetainedIDsInBoundedBatches(t *testing.T) {
	client := &manyIssueClient{payloads: map[string]string{}}
	store := NewStore(client, "issue-batches")
	for i := 0; i < 1001; i++ {
		id := fmt.Sprintf("github:issue:octo/api:%d", i)
		key := fmt.Sprintf("row-%04d", i)
		raw, err := json.Marshal(model.Row{"id": id, "isPullRequest": false})
		if err != nil {
			t.Fatal(err)
		}
		client.keys = append(client.keys, key)
		client.payloads[key] = string(raw)
	}
	source, _, err := store.ReadSource(t.Context(), "issues", nil)
	if err != nil || len(source.Rows) != 1001 {
		t.Fatalf("loaded %d rows: %v", len(source.Rows), err)
	}
	if len(client.lookups) != 32 || len(client.lookups[0]) != 34 || len(client.lookups[31]) != 11 {
		t.Fatalf("unbounded or missing status lookups: %d calls", len(client.lookups))
	}
	for _, call := range client.lookups {
		if call[0] != "HMGET" || call[1] != store.issueStatusKey() {
			t.Fatalf("unexpected status lookup: %v", call[:2])
		}
	}
}

type issueCommandClient struct {
	command []string
	row     string
	overlay string
	result  []any
}

func TestIssueWebhookRedisIntegration(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "issue-webhook-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	ctx := t.Context()
	issueID := "github:issue:octo/api:12"
	if err := store.HashSet(ctx, "collect:repository-installation", "octo/api", "42"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetAdd(ctx, "collect:repositories", "octo/api"); err != nil {
		t.Fatal(err)
	}
	publish := func(observed string) {
		t.Helper()
		token, err := store.BeginDataset(ctx)
		if err != nil {
			t.Fatal(err)
		}
		row := model.Row{"id": issueID, "repositoryFullName": "octo/api", "isPullRequest": false,
			"state": "OPEN", "statusObservedAt": observed}
		if err := store.StageSource(ctx, token, model.Source{Source: "issues", Rows: []model.Row{row},
			Metadata: model.Metadata{"source-id": "issues"}}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.PublishDataset(ctx, token, observed, time.Now(), map[string]int{"issues": 1}); err != nil {
			t.Fatal(err)
		}
	}
	publish("2026-01-02T03:04:05Z")
	update := IssueUpdate{Repository: "octo/api", InstallationID: 42, ID: issueID, Delivery: "first",
		State: "CLOSED", ObservedAt: "2026-01-02T03:04:06Z"}
	changed, _, _, err := store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || !changed {
		t.Fatalf("status update changed=%v err=%v", changed, err)
	}
	loaded, _, err := store.ReadSource(ctx, "issues", nil)
	if err != nil || loaded.Rows[0]["state"] != "CLOSED" {
		t.Fatalf("overlay not applied: %+v %v", loaded.Rows, err)
	}
	changed, duplicate, _, err := store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed || !duplicate {
		t.Fatalf("duplicate delivery was applied: changed=%v duplicate=%v err=%v", changed, duplicate, err)
	}
	update.Delivery = "stale"
	update.ObservedAt = "2026-01-02T03:04:04Z"
	changed, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed {
		t.Fatalf("stale delivery was applied: changed=%v err=%v", changed, err)
	}
	update.Delivery = "same-second-conflict"
	update.State = "OPEN"
	update.ObservedAt = "2026-01-02T03:04:06Z"
	changed, duplicate, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if !errors.Is(err, ErrIssueStatusAmbiguous) || changed || duplicate {
		t.Fatalf("equal-time conflict was not rejected: changed=%v duplicate=%v err=%v", changed, duplicate, err)
	}
	publish("2026-01-02T03:04:07Z")
	loaded, _, err = store.ReadSource(ctx, "issues", nil)
	if err != nil || loaded.Rows[0]["state"] != "OPEN" {
		t.Fatalf("stale overlay won: %+v %v", loaded.Rows, err)
	}
	update.Delivery = "other-installation"
	update.InstallationID = 99
	update.ObservedAt = "2026-01-02T03:04:08Z"
	changed, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed {
		t.Fatalf("other installation changed the issue: changed=%v err=%v", changed, err)
	}
	update.InstallationID = 42
	update.Delivery = "not-retained"
	update.ID = "github:issue:octo/api:13"
	changed, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed {
		t.Fatalf("unretained issue was admitted: changed=%v err=%v", changed, err)
	}
	update.ID = issueID
	update.Delivery = "unenrolled"
	if err := store.SetRemove(ctx, "collect:repositories", "octo/api"); err != nil {
		t.Fatal(err)
	}
	changed, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed {
		t.Fatalf("unenrolled repository was admitted: changed=%v err=%v", changed, err)
	}
	if _, err := store.SetAdd(ctx, "collect:repositories", "octo/api"); err != nil {
		t.Fatal(err)
	}
	token, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishDataset(ctx, token, "empty", time.Now(), map[string]int{}); err != nil {
		t.Fatal(err)
	}
	if err := store.PruneIssueStatuses(ctx); err != nil {
		t.Fatal(err)
	}
	if value, err := client.Do(ctx, "HGET", store.issueStatusKey(), issueID); err != nil || value != nil {
		t.Fatalf("removed source retained issue status: %v (%v)", value, err)
	}
	update.Delivery = "after-removal"
	changed, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed {
		t.Fatalf("removed issue was admitted: changed=%v err=%v", changed, err)
	}
	token, err = store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.StageSource(ctx, token, model.Source{Source: "issues",
		Rows: []model.Row{{"id": issueID, "repositoryFullName": "octo/api",
			"isPullRequest": true, "url": "https://github.com/octo/api/pull/12",
			"state": "OPEN"}}, Metadata: model.Metadata{"source-id": "issues"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishDataset(ctx, token, "pull-request", time.Now(),
		map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	update.Delivery = "pull-request"
	changed, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed {
		t.Fatalf("pull request was admitted as an issue: changed=%v err=%v", changed, err)
	}
}

func (c *issueCommandClient) Do(_ context.Context, command ...string) (any, error) {
	c.command = append([]string(nil), command...)
	switch command[0] {
	case "EVAL":
		if command[2] == "8" {
			if c.result != nil {
				return c.result, nil
			}
			return []any{int64(1), int64(0), int64(7)}, nil
		}
		return []any{"0", []any{"_staged", "1", "issue-row", c.row}}, nil
	case "HSCAN":
		return []any{"0", []any{"_staged", "1", "issue-row", c.row}}, nil
	case "HGET":
		return `{"availability":"available"}`, nil
	case "HMGET":
		return []any{c.overlay}, nil
	}
	return nil, nil
}

func (*issueCommandClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }

func TestApplyIssueUpdateScopesAtomicWriteAndRevision(t *testing.T) {
	client := &issueCommandClient{}
	store := NewStore(client, "issue-test")
	applied, duplicate, revision, err := store.ApplyIssueUpdate(t.Context(), IssueUpdate{
		Repository: "octo/api", InstallationID: 42, ID: "github:issue:octo/api:12",
		Delivery: "delivery-1", State: "CLOSED", StateReason: "completed",
		ObservedAt: "2026-01-02T03:04:06.000000000Z",
	}, time.Hour)
	if err != nil || !applied || duplicate || revision != 7 {
		t.Fatalf("issue status result: applied=%v duplicate=%v revision=%d err=%v", applied, duplicate, revision, err)
	}
	command := client.command
	if len(command) != 24 || command[0] != "EVAL" || command[2] != "8" ||
		command[3] != store.activeKey() || command[4] != store.datasetKey() ||
		command[5] != store.deliveryKey("delivery-1") ||
		command[6] != store.Key("collect:repository-installation") ||
		command[7] != store.revisionSequenceKey() ||
		command[8] != store.Key("collect:repositories") ||
		command[9] != store.issueStatusKey() || command[10] != store.issueStatusAgeKey() ||
		command[11] != "octo/api" || command[12] != "42" ||
		command[17] != "github:issue:octo/api:12" ||
		!strings.Contains(command[1], `redis.call("HGET", ARGV[3], ARGV[5])`) ||
		strings.Contains(command[1], "HGETALL") {
		t.Fatalf("unsafe issue mutation command: %#v", command)
	}
}

func TestIssueOverlayOnlyWinsOverOlderProjection(t *testing.T) {
	client := &issueCommandClient{
		overlay: `{"state":"CLOSED","closed":true,"statusObservedAt":"2026-01-02T03:04:06.000000000Z","repository":"octo/api","rowHash":"` +
			rowID(model.Row{"id": "github:issue:octo/api:12"}, 0) + `"}`,
	}

	store := NewStore(client, "issue-test")
	for _, tc := range []struct {
		snapshot, want string
	}{
		{"2026-01-02T03:04:05Z", "CLOSED"},
		{"2026-01-02T03:04:07Z", "OPEN"},
		{"2026-01-02T03:04:06Z", "OPEN"},
	} {
		client.row = `{"id":"github:issue:octo/api:12","repositoryFullName":"octo/api","isPullRequest":false,"state":"OPEN","statusObservedAt":"` + tc.snapshot + `"}`
		source, _, err := store.ReadSource(t.Context(), "issues", nil)
		if err != nil {
			t.Fatal(err)
		}

		if got := source.Rows[0]["state"]; got != tc.want {
			t.Fatalf("snapshot=%s: state=%v, want %s", tc.snapshot, got, tc.want)
		}
		if client.command[0] != "HMGET" || client.command[1] != store.issueStatusKey() ||
			len(client.command) != 3 {
			t.Fatalf("expected bounded status lookup for the retained issue: %v", client.command)
		}
	}
}

func TestIssueOverlayCannotCrossRepositoryOrIdentity(t *testing.T) {
	id := "github:issue:octo/api:12"
	client := &issueCommandClient{
		row: `{"id":"` + id + `","repositoryFullName":"octo/api","isPullRequest":false,"state":"OPEN","statusObservedAt":"2026-01-02T03:04:05Z"}`,
	}

	store := NewStore(client, "issue-test")
	for _, update := range []string{
		`{"repository":"another/repo","rowHash":"` + rowID(model.Row{"id": id}, 0) + `","state":"CLOSED","statusObservedAt":"2026-01-02T03:04:06Z"}`,
		`{"repository":"octo/api","rowHash":"wrong","state":"CLOSED","statusObservedAt":"2026-01-02T03:04:06Z"}`,
	} {
		client.overlay = update
		source, _, err := store.ReadSource(t.Context(), "issues", nil)
		if err != nil || source.Rows[0]["state"] != "OPEN" {
			t.Fatalf("unrelated overlay changed issue: %+v (%v)", source.Rows, err)
		}
	}
}

func TestAmbiguousIssueStatusIsNotApplied(t *testing.T) {
	id := "github:issue:octo/api:12"
	client := &issueCommandClient{
		row: `{"id":"` + id + `","repositoryFullName":"octo/api","isPullRequest":false,"state":"OPEN","statusObservedAt":"2026-01-02T03:04:05Z"}`,
		overlay: `{"ambiguous":true,"repository":"octo/api","rowHash":"` +
			rowID(model.Row{"id": id}, 0) + `","statusObservedAt":"2026-01-02T03:04:06Z"}`,
	}
	store := NewStore(client, "issue-test")
	source, _, err := store.ReadSource(t.Context(), "issues", nil)
	if err != nil || source.Rows[0]["state"] != "OPEN" {
		t.Fatalf("ambiguous overlay changed issue: %+v (%v)", source.Rows, err)
	}
}

func TestApplyIssueUpdateReportsAmbiguousResult(t *testing.T) {
	client := &issueCommandClient{result: []any{int64(0), int64(2), int64(7)}}
	store := NewStore(client, "issue-test")
	updated, duplicate, revision, err := store.ApplyIssueUpdate(t.Context(), IssueUpdate{
		Repository: "octo/api", InstallationID: 42, ID: "github:issue:octo/api:12",
		Delivery: "conflict", ObservedAt: "2026-01-02T03:04:06Z",
	}, time.Hour)
	if updated || duplicate || revision != 7 || !errors.Is(err, ErrIssueStatusAmbiguous) {
		t.Fatalf("ambiguous result updated=%v duplicate=%v revision=%d err=%v", updated, duplicate, revision, err)
	}
	if !strings.Contains(client.command[1], "previous.ambiguous") ||
		!strings.Contains(client.command[1], "snapshot == incoming and differs(issue)") {
		t.Fatal("script did not check both webhook and snapshot conflicts")
	}
}
