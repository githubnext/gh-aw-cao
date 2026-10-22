package postgresx

import (
	"strings"
	"testing"
	"time"
)

func TestProvisionedPartitionsUseUTCAtDSTBoundary(t *testing.T) {
	store, _ := nativeTestStore(t)
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	// Across fall-back, seven local calendar days reach the preceding UTC day.
	now := time.Date(2026, time.November, 2, 0, 30, 0, 0, time.UTC)
	if err := store.RunPartitionMaintenance(t.Context(), now, 30, 7); err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{now, now.In(location)} {
		if err := store.checkProvisionedPartitions(t.Context(), at, 30, 7); err != nil {
			t.Fatalf("provisioned UTC window rejected with location %s: %v", at.Location(), err)
		}
	}
}

func TestWeeklyPartitionsRequireFreshCanonicalStorage(t *testing.T) {
	store, _ := nativeTestStore(t)
	now := time.Now().UTC()
	at := dayStart(now.AddDate(0, 0, -100))
	name := "runs_w" + at.Format("20060102")
	if _, err := store.db.ExecContext(t.Context(), "CREATE TABLE "+name+
		" PARTITION OF runs FOR VALUES FROM ('"+at.Format(time.RFC3339)+
		"') TO ('"+at.AddDate(0, 0, 7).Format(time.RFC3339)+"')"); err != nil {
		t.Fatal(err)
	}
	for _, check := range []func() error{
		func() error { return store.checkProvisionedPartitions(t.Context(), now, 30, 7) },
		func() error { return store.RunPartitionMaintenance(t.Context(), now, 30, 7) },
	} {
		if err := check(); err == nil || !strings.Contains(err.Error(), "daily partitions required") {
			t.Fatalf("weekly layout was not rejected with rebuild guidance: %v", err)
		}
	}
	var exists bool
	if err := store.db.QueryRowContext(t.Context(), "SELECT to_regclass($1) IS NOT NULL", name).Scan(&exists); err != nil || !exists {
		t.Fatalf("rejected weekly layout was mutated: exists=%v err=%v", exists, err)
	}
}
