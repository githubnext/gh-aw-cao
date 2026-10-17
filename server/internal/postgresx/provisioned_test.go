package postgresx

import (
	"testing"
	"time"
)

func TestProvisionedPartitionsUseUTCAtDSTBoundary(t *testing.T) {
	store, _ := nativeTestStore(t)
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	// Just after UTC Monday following the local fall-back transition, seven
	// local calendar days reach the preceding UTC week rather than this one.
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
