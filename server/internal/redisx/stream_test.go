package redisx

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type streamCommandClient struct {
	value   any
	err     error
	command []string
}

func (c *streamCommandClient) Do(_ context.Context, command ...string) (any, error) {
	c.command = append([]string(nil), command...)
	return c.value, c.err
}

func (c *streamCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, errors.New("unexpected DoMany")
}

func TestStreamReplaceAndAckUsesOneAtomicCommand(t *testing.T) {
	client := &streamCommandClient{value: int64(1)}
	store := NewStore(client, "test")
	err := store.StreamReplaceAndAck(context.Background(), "tasks", "workers", "1-0", "tasks", 0, map[string]string{"task": "{}"})
	if err != nil {
		t.Fatal(err)
	}
	if client.command[0] != "EVAL" {
		t.Fatalf("command = %q, want EVAL", client.command[0])
	}
	script := client.command[1]
	add := strings.Index(script, `redis.call("XADD"`)
	ack := strings.Index(script, `redis.call("XACK"`)
	if add < 0 || ack < 0 || add >= ack {
		t.Fatalf("replacement must be persisted before ACK:\n%s", script)
	}
}

func TestStreamReplaceFailureCannotIssueSeparateAck(t *testing.T) {
	client := &streamCommandClient{err: errors.New("injected Redis failure")}
	store := NewStore(client, "test")
	err := store.StreamReplaceAndAck(context.Background(), "tasks", "workers", "1-0", "tasks", 0, map[string]string{"task": "{}"})
	if err == nil {
		t.Fatal("expected injected failure")
	}
	if len(client.command) == 0 || client.command[0] != "EVAL" {
		t.Fatalf("commands = %v, want one atomic EVAL", client.command)
	}
}

func TestStreamEnqueueDeliveryCombinesDedupDebounceAndAppend(t *testing.T) {
	client := &streamCommandClient{value: int64(2)}
	store := NewStore(client, "test")
	result, err := store.StreamEnqueueDelivery(
		context.Background(), "delivery-1", time.Hour,
		"tasks", "debounce:octo/api", time.Minute, 100,
		map[string]string{"task": "{}"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result != DeliveryEnqueued {
		t.Fatalf("result = %v, want DeliveryEnqueued", result)
	}
	script := client.command[1]
	if strings.Index(script, `redis.call("XADD"`) > strings.LastIndex(script, `redis.call("SET", KEYS[1]`) {
		t.Fatal("delivery must not be committed before the task append")
	}
}

func TestStreamAddNeverUsesDestructiveMaxLengthTrimming(t *testing.T) {
	client := &streamCommandClient{value: "1-0"}
	store := NewStore(client, "test")
	if _, err := store.StreamAdd(context.Background(), "tasks", 1, map[string]string{"task": "{}"}); err != nil {
		t.Fatal(err)
	}
	for _, argument := range client.command {
		if argument == "MAXLEN" {
			t.Fatal("task append must not trim recoverable stream entries")
		}
	}
}

// groupEntry builds one XINFO GROUPS reply entry as alternating field
// name/value pairs, matching the shape the real Redis client returns.
func groupEntry(name string, lag any, pending int64) []any {
	return []any{
		"name", name,
		"lag", lag,
		"pending", pending,
	}
}

func TestFindGroupBacklogReturnsExactLagWhenKnown(t *testing.T) {
	groups := []any{groupEntry("workers", int64(7), 12)}

	backlog, lagKnown, found := findGroupBacklog(groups, "workers")

	if !found {
		t.Fatal("expected group to be found")
	}
	if !lagKnown {
		t.Fatal("expected lag to be known")
	}
	if backlog != 7 {
		t.Fatalf("backlog = %d, want 7", backlog)
	}
}

func TestFindGroupBacklogFallsBackToPendingWhenLagIsNil(t *testing.T) {
	groups := []any{groupEntry("workers", nil, 12)}

	backlog, lagKnown, found := findGroupBacklog(groups, "workers")

	if !found {
		t.Fatal("expected group to be found")
	}
	if lagKnown {
		t.Fatal("expected lag to be unknown")
	}
	if backlog != 12 {
		t.Fatalf("backlog = %d, want fallback pending count 12", backlog)
	}
}

func TestFindGroupBacklogReturnsNotFoundForUnmatchedGroup(t *testing.T) {
	groups := []any{groupEntry("other", int64(3), 1)}

	backlog, lagKnown, found := findGroupBacklog(groups, "workers")

	if found {
		t.Fatal("expected no match for a different group name")
	}
	if lagKnown {
		t.Fatal("lagKnown should be false when the group was not found")
	}
	if backlog != 0 {
		t.Fatalf("backlog = %d, want 0 when not found", backlog)
	}
}

func TestFindGroupBacklogMatchesByteNameField(t *testing.T) {
	// Some Redis client transports surface field names as []byte rather
	// than string, so the name lookup must tolerate both.
	groups := []any{
		[]any{[]byte("name"), []byte("workers"), "lag", int64(4), "pending", int64(9)},
	}

	backlog, lagKnown, found := findGroupBacklog(groups, "workers")

	if !found || !lagKnown || backlog != 4 {
		t.Fatalf("found=%v lagKnown=%v backlog=%d, want found=true lagKnown=true backlog=4", found, lagKnown, backlog)
	}
}

func TestFindGroupBacklogSkipsMalformedEntries(t *testing.T) {
	groups := []any{
		"not-a-slice",
		groupEntry("workers", int64(2), 5),
	}

	backlog, lagKnown, found := findGroupBacklog(groups, "workers")

	if !found || !lagKnown || backlog != 2 {
		t.Fatalf("found=%v lagKnown=%v backlog=%d, want the well-formed entry to match", found, lagKnown, backlog)
	}
}
