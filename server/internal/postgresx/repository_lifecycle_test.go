package postgresx

import (
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestRepositoryLifecycleSurvivesProjectionAndExpires(t *testing.T) {
	store, _ := nativeTestStore(t)
	ctx := t.Context()
	if err := store.UpdateRepositoryLifecycle(ctx, 42, "octo/api", "active", time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, lifecycle := range []string{"archived", "active", "deleted"} {
		if err := store.UpdateRepositoryLifecycle(ctx, 42, "octo/api", lifecycle, time.Now()); err != nil {
			t.Fatal(err)
		}
		var got string
		if err := store.db.QueryRowContext(ctx, `SELECT lifecycle FROM repositories WHERE namespace=$1 AND id=$2`,
			store.namespace, "github:repository:42").Scan(&got); err != nil || got != lifecycle {
			t.Fatalf("repository lifecycle = %q, error %v, want %q", got, err, lifecycle)
		}
	}
	writer, err := store.BeginIngestion(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(ctx)
	if err := writer.Append(ctx, "$repositories", model.Row{
		"id": "github:repository:42", "owner": "octo", "name": "api",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Publish(ctx, "after-lifecycle"); err != nil {
		t.Fatal(err)
	}
	var lifecycle string
	if err := store.db.QueryRowContext(ctx, `SELECT lifecycle FROM repositories WHERE namespace=$1 AND id=$2`,
		store.namespace, "github:repository:42").Scan(&lifecycle); err != nil || lifecycle != "deleted" {
		t.Fatalf("projection lost lifecycle: %q, %v", lifecycle, err)
	}
	active, err := store.RepositoryActive(ctx, "octo/api")
	if err != nil || active {
		t.Fatalf("deleted repository remains collectible: %t, %v", active, err)
	}
	if err := store.UpdateRepositoryLifecycle(ctx, 42, "octo/api", "active", time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT lifecycle FROM repositories WHERE namespace=$1 AND id=$2`,
		store.namespace, "github:repository:42").Scan(&lifecycle); err != nil || lifecycle != "deleted" {
		t.Fatalf("stale created task revived deleted repository: %q, %v", lifecycle, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE cao_repository_lifecycle SET changed_at=$1 WHERE namespace=$2`,
		time.Now().AddDate(0, 0, -9), store.namespace); err != nil {
		t.Fatal(err)
	}
	if err := store.RunPartitionMaintenance(ctx, time.Now(), 7); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_repository_lifecycle WHERE namespace=$1`, store.namespace).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired lifecycle rows = %d, %v", count, err)
	}
}

func TestRepositoryLifecyclePresence(t *testing.T) {
	mask := repositoryLifecyclePresence()
	if len(mask) != len(entityTables["$repositories"].columns) ||
		strings.Count(mask, "1") != 4 {
		t.Fatalf("invalid repository presence mask %q", mask)
	}
}
