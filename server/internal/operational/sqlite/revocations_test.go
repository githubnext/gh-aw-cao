package sqlite

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

func TestRevocationsProtectDebtAndRotateFairly(t *testing.T) {
	store, err := Open(t.Context(), filepath.Join(t.TempDir(), "revocations.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	for _, id := range []string{"first", "second"} {
		if err := store.QueueRevocation(t.Context(), id, "sealed", "cli"); err != nil {
			t.Fatal(err)
		}
	}
	one, err := store.PendingRevocation(t.Context(), "cli")
	if err != nil {
		t.Fatal(err)
	}
	two, err := store.PendingRevocation(t.Context(), "cli")
	if err != nil || one.ID == two.ID {
		t.Fatal("failed revocations must rotate without starving other tokens")
	}
	if err := store.QueueRevocation(t.Context(), one.ID, "replacement-sealed", "cli"); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteRevocation(t.Context(), one.ID, one.Value, "cli"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM cao_operational_cli_revocations`).Scan(&count); err != nil || count != 2 {
		t.Fatal("stale completion deleted replacement debt")
	}
	if err := store.QueueRevocation(t.Context(), "large", strings.Repeat("x", 16*1024+1), "cli"); err == nil {
		t.Fatal("oversized cleanup record was accepted")
	}
	if _, err := store.db.ExecContext(t.Context(), `WITH RECURSIVE numbers(n) AS
		(SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<4094)
		INSERT INTO cao_operational_cli_revocations SELECT 'cli','filler-'||n,'sealed',n FROM numbers`); err != nil {
		t.Fatal(err)
	}
	if err := store.QueueRevocation(t.Context(), "overflow", "sealed", "cli"); !errors.Is(err, operational.ErrCapacity) {
		t.Fatal("cleanup journal must fail closed at capacity")
	}
	if err := store.CompleteRevocation(t.Context(), one.ID, "replacement-sealed", "cli"); err != nil {
		t.Fatal(err)
	}
	if err := store.QueueRevocation(t.Context(), "after-cleanup", "sealed", "cli"); err != nil {
		t.Fatal("confirmed cleanup did not release capacity")
	}
}
