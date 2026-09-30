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
	case "SMEMBERS":
		return c.keys, nil
	case "EVAL":
		out := make([]any, 0, len(command)-3)
		for _, key := range command[3:] {
			out = append(out, c.payloads[key])
		}
		return out, nil
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
	source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
	if err != nil || len(source.Rows) != 1001 {
		t.Fatalf("loaded %d rows: %v", len(source.Rows), err)
	}
	if len(client.lookups) != 2 || len(client.lookups[0]) != 1002 || len(client.lookups[1]) != 3 {
		t.Fatalf("unbounded or missing status lookups: %d calls", len(client.lookups))
	}
	for _, call := range client.lookups {
		if call[0] != "HMGET" || call[1] != store.issueStatusKey() {
			t.Fatalf("unexpected status lookup: %v", call[:2])
		}
	}
}

func TestActivateDoesNotScanIssueOverlay(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	store := NewStore(client, "issue-activation")
	_, err := store.Activate(t.Context(), "g2", "revision", time.Now(), map[string]int{"issues": 1})
	// The fake only returns "OK", not the integer revision produced by Redis.
	if err == nil || !strings.Contains(err.Error(), "invalid revision") {
		t.Fatalf("unexpected activation result: %v", err)
	}
	command := client.command
	if command[0] != "EVAL" || command[2] != "5" || len(command) != 17 ||
		command[6] != store.issueStatusKey() || command[7] != store.issueStatusAgeKey() ||
		strings.Contains(command[1], "HGETALL") ||
		!strings.Contains(command[1], `"LIMIT", 0, 100`) ||
		!strings.Contains(command[1], "snapshot >= observed") {
		t.Fatalf("activation must be bounded: %v", command)
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
	expireStatus := func() {
		t.Helper()
		if _, err := store.Client.Do(ctx, "ZADD", store.issueStatusAgeKey(),
			strconv.FormatInt(time.Now().Add(-31*24*time.Hour).Unix(), 10), issueID); err != nil {
			t.Fatal(err)
		}
	}
	expireStatus()
	if _, err := store.Activate(ctx, "g1", "retained", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	load("g1", "CLOSED") // expiry cannot discard an observation newer than the snapshot
	apply(false)         // delivery deduplication
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
	load("g3", "OPEN")   // newer projection wins
	load("g1", "CLOSED") // rollback reads the same latest observation
	if err := store.PutSource(ctx, "g-empty", model.Source{
		Source: "issues", Metadata: model.Metadata{"availability": "available"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(ctx, "g-empty", "snapshot-empty", time.Now(), map[string]int{"issues": 0}); err != nil {
		t.Fatal(err)
	}
	empty, _, err := store.LoadSource(ctx, "g-empty", "issues", nil)
	if err != nil || len(empty.Rows) != 0 {
		t.Fatalf("status overlay resurrected a removed issue: %+v (%v)", empty.Rows, err)
	}
	if _, err := store.Activate(ctx, "g3", "rollback", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
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
	if _, err := store.Activate(ctx, "g1", "rollback-again", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	load("g1", "CLOSED")
	update.InstallationID = 42
	update.ID = issueID
	update.Delivery = "same-status"
	update.ObservedAt = "2026-01-02T03:04:08Z"
	apply(false) // matching observation at the same instant is harmless
	update.Delivery = "same-second-conflict"
	update.State = "OPEN"
	update.StateReason = ""
	update.ClosedAt = ""
	changed, duplicate, _, err := store.ApplyIssueUpdate(ctx, update, time.Hour)
	if !errors.Is(err, ErrIssueStatusAmbiguous) || changed || duplicate {
		t.Fatalf("equal-time conflict was not reported: changed=%v duplicate=%v err=%v", changed, duplicate, err)
	}
	load("g1", "OPEN") // neither conflicting webhook is safe to apply
	afterConflict, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	changed, duplicate, revision, err := store.ApplyIssueUpdate(ctx, update, time.Hour)
	if err != nil || changed || !duplicate || revision != 0 {
		t.Fatalf("ambiguous delivery replay was not deduplicated: changed=%v duplicate=%v revision=%d err=%v", changed, duplicate, revision, err)
	}
	afterReplay, err := store.Active(ctx)
	if err != nil || afterReplay.Revision != afterConflict.Revision {
		t.Fatalf("ambiguous delivery replay changed revision: before=%d after=%d err=%v",
			afterConflict.Revision, afterReplay.Revision, err)
	}
	load("g1", "OPEN")
	update.Delivery = "newer-after-conflict"
	update.ObservedAt = "2026-01-02T03:04:10Z"
	apply(true)
	load("g1", "OPEN")
	if err := store.DropGeneration(ctx, "g1"); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSource(ctx, "g5", source(issueRow("2026-01-02T03:04:12Z"))); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(ctx, "g5", "snapshot5", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	update.Delivery = "snapshot-same-second-conflict"
	update.State = "CLOSED"
	update.StateReason = "completed"
	update.ClosedAt = "2026-01-02T03:04:12Z"
	update.ObservedAt = "2026-01-02T03:04:12Z"
	_, _, _, err = store.ApplyIssueUpdate(ctx, update, time.Hour)
	if !errors.Is(err, ErrIssueStatusAmbiguous) {
		t.Fatalf("equal-time conflict with projection was not reported: %v", err)
	}
	load("g5", "OPEN")
	expireStatus()
	if _, err := store.Activate(ctx, "g5", "caught-up", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	if value, err := client.Do(ctx, "HGET", store.issueStatusKey(), issueID); err != nil || value != nil {
		t.Fatalf("caught-up snapshot did not prune overlay: %v (%v)", value, err)
	}
	update.Delivery = "absent-overlay"
	update.ObservedAt = "2026-01-02T03:04:13Z"
	apply(true)
	expireStatus()
	if _, err := store.Activate(ctx, "g-empty", "removed", time.Now(), map[string]int{"issues": 0}); err != nil {
		t.Fatal(err)
	}
	if value, err := client.Do(ctx, "HGET", store.issueStatusKey(), issueID); err != nil || value != nil {
		t.Fatalf("removed issue did not prune overlay: %v (%v)", value, err)
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
		return []any{c.row}, nil
	case "SMEMBERS":
		return []any{"issue-row"}, nil
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
		command[3] != store.activeKey() || command[4] != store.activeGenerationKey() ||
		command[5] != store.deliveryKey("delivery-1") ||
		command[6] != store.Key("collect:repository-installation") ||
		command[7] != store.revisionSequenceKey() ||
		command[8] != store.Key("collect:repositories") ||
		command[9] != store.issueStatusKey() || command[10] != store.issueStatusAgeKey() ||
		command[11] != "octo/api" || command[12] != "42" ||
		command[17] != "github:issue:octo/api:12" ||
		!strings.Contains(command[1], `redis.call("SISMEMBER", setkey, rowkey)`) ||
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
		source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
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
		source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
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
	source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
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
