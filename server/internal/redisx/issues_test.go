package redisx

import (
	"context"
	"strings"
	"testing"
	"time"
)

type issueCommandClient struct {
	command []string
	row     string
	overlay string
}

func (c *issueCommandClient) Do(_ context.Context, command ...string) (any, error) {
	c.command = append([]string(nil), command...)
	switch command[0] {
	case "EVAL":
		if command[2] == "5" {
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
	if len(command) != 21 || command[0] != "EVAL" || command[2] != "5" ||
		command[3] != store.activeKey() || command[4] != store.activeGenerationKey() ||
		command[5] != store.deliveryKey("delivery-1") ||
		command[6] != store.Key("collect:repository-installation") ||
		command[7] != store.revisionSequenceKey() ||
		command[8] != "octo/api" || command[9] != "42" ||
		command[14] != "github:issue:octo/api:12" ||
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
		client.row = `{"id":"github:issue:octo/api:12","state":"OPEN","statusObservedAt":"` + tc.snapshot + `"}`
		source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := source.Rows[0]["state"]; got != tc.want {
			t.Fatalf("snapshot=%s: state=%v, want %s", tc.snapshot, got, tc.want)
		}
	}
}
