package redisx

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

type issueCommandClient struct {
	command []string
	row     string
	overlay string
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
	issueRow := func(observed string) model.Row {
		return model.Row{"id": issueID, "repositoryFullName": "octo/api",
			"isPullRequest": false, "state": "OPEN", "statusObservedAt": observed}
	}
	source := func(row model.Row) model.Source {
		return model.Source{Source: "issues", Rows: []model.Row{row},
			Metadata: model.Metadata{"availability": "available"}}
	}
	if err := store.HashSet(ctx, "collect:repository-installation", "octo/api", "42"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetAdd(ctx, "collect:repositories", "octo/api"); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSource(ctx, "g1", source(issueRow("2026-01-02T03:04:05Z"))); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(ctx, "g1", "snapshot1", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	update := IssueUpdate{Repository: "octo/api", InstallationID: 42,
		ID: issueID, Delivery: "first", State: "CLOSED", StateReason: "completed",
		ClosedAt: "2026-01-02T03:04:06Z", ObservedAt: "2026-01-02T03:04:06.000000000Z"}
	apply := func(want bool) {
		t.Helper()
		changed, _, _, err := store.ApplyIssueUpdate(ctx, update, time.Hour)
		if err != nil || changed != want {
			t.Fatalf("issue update changed=%v want=%v err=%v", changed, want, err)
		}
	}
	apply(true)
	active, err := store.Active(ctx)
	if err != nil || active.Revision != 2 {
		t.Fatalf("missing issue revision: %+v %v", active, err)
	}
	load := func(generation, want string) {
		t.Helper()
		loaded, _, err := store.LoadSource(ctx, generation, "issues", nil)
		if err != nil || len(loaded.Rows) != 1 || loaded.Rows[0]["state"] != want {
			t.Fatalf("%s: expected %s, got %+v (%v)", generation, want, loaded.Rows, err)
		}
	}
	load("g1", "CLOSED")
	apply(false) // delivery deduplication
	update.Delivery = "stale"
	update.ObservedAt = "2026-01-02T03:04:04.000000000Z"
	apply(false)
	update.Delivery = "reopened"
	update.State = "OPEN"
	update.StateReason = ""
	update.ClosedAt = ""
	update.ObservedAt = "2026-01-02T03:04:07.000000000Z"
	apply(true)
	load("g1", "OPEN")
	update.Delivery = "closed-again"
	update.State = "CLOSED"
	update.StateReason = "completed"
	update.ClosedAt = "2026-01-02T03:04:08Z"
	update.ObservedAt = "2026-01-02T03:04:08.000000000Z"
	apply(true)
	load("g1", "CLOSED")
	update.Delivery = "other-installation"
	update.InstallationID = 99
	update.ObservedAt = "2026-01-02T03:04:10.000000000Z"
	apply(false)
	if err := store.PutSource(ctx, "g2", source(issueRow("2026-01-02T03:04:05Z"))); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(ctx, "g2", "snapshot2", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	load("g2", "CLOSED") // activation carries the more recent observation
	if err := store.PutSource(ctx, "g3", source(issueRow("2026-01-02T03:04:09Z"))); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(ctx, "g3", "snapshot3", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	load("g3", "OPEN") // newer projection wins
	update.Delivery = "not-retained"
	update.ID = "github:issue:octo/api:13"
	update.InstallationID = 42
	apply(false)
	update.ID = issueID
	update.Delivery = "withdrawn"
	if err := store.SetRemove(ctx, "collect:repositories", "octo/api"); err != nil {
		t.Fatal(err)
	}
	apply(false)
	load("g3", "OPEN")
	if _, err := store.SetAdd(ctx, "collect:repositories", "octo/api"); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSource(ctx, "g4", source(model.Row{
		"id": issueID, "repositoryFullName": "octo/api", "isPullRequest": true,
		"url": "https://github.com/octo/api/pull/12", "state": "OPEN",
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(ctx, "g4", "snapshot4", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	update.Delivery = "pull-request"
	apply(false)
	load("g4", "OPEN")
	if err := store.DropGeneration(ctx, "g1"); err != nil {
		t.Fatal(err)
	}
}

func (c *issueCommandClient) Do(_ context.Context, command ...string) (any, error) {
	c.command = append([]string(nil), command...)
	switch command[0] {
	case "EVAL":
		if command[2] == "6" {
			return []any{int64(1), int64(0), int64(7)}, nil
		}
		return []any{c.row}, nil
	case "SMEMBERS":
		return []any{"issue-row"}, nil
	case "HGET":
		return `{"availability":"available"}`, nil
	case "HGETALL":
		return []any{"github:issue:octo/api:12", c.overlay}, nil
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
	if len(command) != 22 || command[0] != "EVAL" || command[2] != "6" ||
		command[3] != store.activeKey() || command[4] != store.activeGenerationKey() ||
		command[5] != store.deliveryKey("delivery-1") ||
		command[6] != store.Key("collect:repository-installation") ||
		command[7] != store.revisionSequenceKey() ||
		command[8] != store.Key("collect:repositories") ||
		command[9] != "octo/api" || command[10] != "42" ||
		command[15] != "github:issue:octo/api:12" ||
		!strings.Contains(command[1], `redis.call("SISMEMBER", setkey, rowkey)`) {
		t.Fatalf("unsafe issue mutation command: %#v", command)
	}
}

func TestIssueOverlayOnlyWinsOverOlderProjection(t *testing.T) {
	client := &issueCommandClient{
		overlay: `{"state":"CLOSED","closed":true,"statusObservedAt":"2026-01-02T03:04:06.000000000Z"}`,
	}
	store := NewStore(client, "issue-test")
	for _, tc := range []struct {
		snapshot, want string
	}{
		{"2026-01-02T03:04:05Z", "CLOSED"},
		{"2026-01-02T03:04:07Z", "OPEN"},
		{"2026-01-02T03:04:06Z", "OPEN"},
	} {
		client.row = `{"id":"github:issue:octo/api:12","isPullRequest":false,"state":"OPEN","statusObservedAt":"` + tc.snapshot + `"}`
		source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := source.Rows[0]["state"]; got != tc.want {
			t.Fatalf("snapshot=%s: state=%v, want %s", tc.snapshot, got, tc.want)
		}
	}
}
