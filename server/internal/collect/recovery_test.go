package collect

import (
	"reflect"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
)

func TestPlanRedeliveriesSelectsOnlyNonSuccessStatuses(t *testing.T) {
	deliveries := []githubapp.Delivery{
		{ID: 3, GUID: "guid-3", StatusCode: 200},
		{ID: 2, GUID: "guid-2", StatusCode: 500},
		{ID: 1, GUID: "guid-1", StatusCode: 422},
	}
	plan := planRedeliveries(deliveries, "")
	if plan.inspected != 3 {
		t.Fatalf("inspected = %d, want 3", plan.inspected)
	}
	if want := []int64{2, 1}; !reflect.DeepEqual(plan.toRedeliver, want) {
		t.Fatalf("toRedeliver = %v, want %v", plan.toRedeliver, want)
	}
	if plan.newest != "guid-3" {
		t.Fatalf("newest = %q, want %q", plan.newest, "guid-3")
	}
}

func TestPlanRedeliveriesStopsAtBoundary(t *testing.T) {
	deliveries := []githubapp.Delivery{
		{ID: 3, GUID: "guid-3", StatusCode: 500},
		{ID: 2, GUID: "guid-2", StatusCode: 500},
		{ID: 1, GUID: "guid-1", StatusCode: 500},
	}
	plan := planRedeliveries(deliveries, "guid-2")
	if plan.inspected != 1 {
		t.Fatalf("inspected = %d, want 1 (only guid-3 precedes the boundary)", plan.inspected)
	}
	if want := []int64{3}; !reflect.DeepEqual(plan.toRedeliver, want) {
		t.Fatalf("toRedeliver = %v, want %v", plan.toRedeliver, want)
	}
	if plan.newest != "guid-3" {
		t.Fatalf("newest = %q, want %q", plan.newest, "guid-3")
	}
}

func TestPlanRedeliveriesHandlesEmptyPage(t *testing.T) {
	plan := planRedeliveries(nil, "guid-1")
	if plan.inspected != 0 {
		t.Fatalf("inspected = %d, want 0", plan.inspected)
	}
	if plan.toRedeliver != nil {
		t.Fatalf("toRedeliver = %v, want nil", plan.toRedeliver)
	}
	if plan.newest != "" {
		t.Fatalf("newest = %q, want empty", plan.newest)
	}
}

func TestPlanRedeliveriesBoundaryAsFirstEntryInspectsNothing(t *testing.T) {
	deliveries := []githubapp.Delivery{
		{ID: 1, GUID: "guid-1", StatusCode: 500},
	}
	plan := planRedeliveries(deliveries, "guid-1")
	if plan.inspected != 0 {
		t.Fatalf("inspected = %d, want 0", plan.inspected)
	}
	if plan.toRedeliver != nil {
		t.Fatalf("toRedeliver = %v, want nil", plan.toRedeliver)
	}
	// newest is still recorded even though the boundary stopped iteration
	// immediately, so the cursor does not regress on a page with no new
	// deliveries.
	if plan.newest != "guid-1" {
		t.Fatalf("newest = %q, want %q", plan.newest, "guid-1")
	}
}

func TestIngestionHealthStateExplainsDegradationAndRecovery(t *testing.T) {
	cases := []struct {
		name   string
		status Status
		events map[string]string
		want   string
	}{
		{name: "idle", status: Status{}, want: "healthy"},
		{name: "backlog", status: Status{QueueDepth: 2}, want: "recovering"},
		{name: "in-flight", status: Status{PendingTasks: 1}, want: "recovering"},
		{
			name: "failure newer than success",
			events: map[string]string{
				"lastFailureAt": "2026-09-29T02:00:00Z",
				"lastSuccessAt": "2026-09-29T01:00:00Z",
			},
			want: "degraded",
		},
		{
			name:   "success after failure with backlog",
			status: Status{QueueDepth: 2},
			events: map[string]string{
				"lastFailureAt": "2026-09-29T01:00:00Z",
				"lastSuccessAt": "2026-09-29T02:00:00Z",
			},
			want: "recovering",
		},
		{name: "dead letter", status: Status{DeadLetters: 1}, want: "degraded"},
		{
			name:   "invalid persisted timestamp",
			events: map[string]string{"lastFailureAt": "not-a-time"},
			want:   "degraded",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := ingestionHealthState(test.status, test.events); got != test.want {
				t.Fatalf("ingestionHealthState() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParseHealthTimeRejectsMissingAndInvalidValues(t *testing.T) {
	if _, ok := parseHealthTime(""); ok {
		t.Fatal("empty timestamp was accepted")
	}
	if _, ok := parseHealthTime(time.Now().Format(time.RFC822)); ok {
		t.Fatal("non-RFC3339 timestamp was accepted")
	}
}
