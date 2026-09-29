package redisx

import "testing"

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
