package githubquota

import (
	"errors"
	"testing"
	"time"
)

func TestObservationsRecordPeakUsageHistory(t *testing.T) {
	service, store := newTestService(t, Options{ReservationTTL: time.Hour})
	ctx := t.Context()
	primary := BucketID{App: "collector", Installation: 1}
	secondary := BucketID{App: "backfill", Installation: 1}
	reset := testNow.Add(time.Hour)

	observe(t, service, primary, 4000, reset)
	observe(t, service, primary, 3000, reset)
	observe(t, service, secondary, 1000, reset)
	if err := service.Observe(ctx, primary, Observation{
		Limit: 5000, Remaining: 4500, ResetAt: testNow.Add(-time.Minute), ObservedAt: testNow,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Reserve(ctx, primary, ReservationRequest{EstimatedCost: 100}); err != nil {
		t.Fatal(err)
	}
	store.advance(UsageInterval)
	if err := service.Observe(ctx, primary, Observation{Limit: 5000, Remaining: 3000, ResetAt: reset}); err != nil {
		t.Fatal(err)
	}

	report, err := service.Usage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !report.GeneratedAt.Equal(testNow.Add(UsageInterval)) || report.IntervalSeconds != 900 ||
		!report.From.Equal(report.GeneratedAt.Add(-UsageRetention)) {
		t.Fatalf("unexpected report window %+v", report)
	}
	slot := testNow.Truncate(UsageInterval)
	wantBuckets := []UsagePoint{
		{Time: slot, Bucket: BucketID{App: "backfill", Installation: 1, Resource: ResourceCore}, Limit: 5000, Used: 4000, UsagePercent: 80},
		{Time: slot, Bucket: BucketID{App: "collector", Installation: 1, Resource: ResourceCore}, Limit: 5000, Used: 2000, UsagePercent: 40},
		{Time: slot.Add(UsageInterval), Bucket: BucketID{App: "collector", Installation: 1, Resource: ResourceCore}, Limit: 5000, Used: 2000, Reserved: 100, UsagePercent: 40},
	}
	if len(report.Buckets) != len(wantBuckets) {
		t.Fatalf("buckets = %+v", report.Buckets)
	}
	for index, want := range wantBuckets {
		if report.Buckets[index] != want {
			t.Fatalf("bucket point %d = %+v, want %+v", index, report.Buckets[index], want)
		}
	}
	wantAggregate := []AggregateUsagePoint{
		{Time: slot, Buckets: 2, Limit: 10000, Used: 6000, UsagePercent: 60},
		{Time: slot.Add(UsageInterval), Buckets: 1, Limit: 5000, Used: 2000, Reserved: 100, UsagePercent: 40},
	}
	if len(report.Aggregate) != len(wantAggregate) {
		t.Fatalf("aggregate = %+v", report.Aggregate)
	}
	for index, want := range wantAggregate {
		if report.Aggregate[index] != want {
			t.Fatalf("aggregate point %d = %+v, want %+v", index, report.Aggregate[index], want)
		}
	}
}

func TestUsageHistoryFailureDoesNotFailObservation(t *testing.T) {
	service, store := newTestService(t, Options{})
	store.usageErr = errors.New("history unavailable")
	bucket := BucketID{App: "collector", Installation: 1}
	observe(t, service, bucket, 4000, testNow.Add(time.Hour))
	state, err := service.State(t.Context(), bucket)
	if err != nil || state.Remaining != 4000 {
		t.Fatalf("observation was not recorded: %+v %v", state, err)
	}
	if _, err := service.Usage(t.Context()); err == nil {
		t.Fatal("usage read failure was not reported")
	}
}

func TestUsageReportExcludesExpiredSlotsAndDegenerateLimits(t *testing.T) {
	service, store := newTestService(t, Options{})
	observe(t, service, BucketID{App: "collector", Installation: 1}, 4000, testNow.Add(time.Hour))
	if err := service.Observe(t.Context(), BucketID{App: "search", Installation: 1, Resource: "search"}, Observation{
		Limit: 0, Remaining: 0, ResetAt: testNow.Add(time.Hour), ObservedAt: testNow,
	}); err != nil {
		t.Fatal(err)
	}
	report, err := service.Usage(t.Context())
	if err != nil || len(report.Buckets) != 2 || report.Buckets[1].UsagePercent != 0 {
		t.Fatalf("unexpected report %+v %v", report, err)
	}
	store.advance(UsageRetention + UsageInterval)
	report, err = service.Usage(t.Context())
	if err != nil || len(report.Buckets) != 0 || len(report.Aggregate) != 0 {
		t.Fatalf("expired history was reported: %+v %v", report, err)
	}
}

func TestParseStorageKey(t *testing.T) {
	bucket := BucketID{App: "collector", Installation: 12, Resource: "graphql"}
	parsed, ok := parseStorageKey(bucket.storageKey())
	if !ok || parsed != bucket {
		t.Fatalf("parseStorageKey() = %+v %t", parsed, ok)
	}
	for _, key := range []string{"collector:12", "collector:x:core", "collector:0:core", "Collector:1:core", "a:1:core:extra"} {
		if _, ok := parseStorageKey(key); ok {
			t.Errorf("parseStorageKey(%q) accepted an invalid key", key)
		}
	}
}
