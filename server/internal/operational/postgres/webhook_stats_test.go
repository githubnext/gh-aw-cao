package postgres

import (
	"testing"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestWebhookQueueStatsMatchRetainedBudgetsAndLiveLeases(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	empty, err := q.QueueStats(t.Context())
	if err != nil || empty.Depth != 0 || empty.RetainedRows != 0 || empty.RetainedBytes != 0 ||
		empty.ActiveWorkers != 0 || empty.OldestAgeSeconds != 0 || len(empty.TenantUtilization) != 0 {
		t.Fatalf("empty stats: %+v %v", empty, err)
	}
	admitWebhook(t, q, "first", webhookJob("one", "a"), webhookJob("two", "a"))
	first := dispatchWebhook(t, q, claimWebhook(t, q))
	admitWebhook(t, q, "second", webhookJob("three", "b"))
	stats, err := q.QueueStats(t.Context())
	if err != nil || stats.Depth != 3 || stats.RetainedRows != 5 || stats.RetainedBytes <= 0 ||
		stats.ActiveWorkers != 1 || stats.WorkerUtilization != 1.0/8 || stats.OldestAgeSeconds < 1 || len(stats.TenantUtilization) != 2 {
		t.Fatalf("active stats: %+v %v", stats, err)
	}
	if stats.TenantUtilization[0] != 3.0/128 || stats.TenantUtilization[1] != 2.0/128 {
		t.Fatalf("tenant ratios do not reflect retained row budgets: %v", stats.TenantUtilization)
	}
	var retainedBytes int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT
		(SELECT coalesce(sum(storage_bytes),0) FROM cao_operational_webhook_jobs WHERE namespace=$1)+
		(SELECT coalesce(sum(storage_bytes),0) FROM cao_operational_webhook_deliveries WHERE namespace=$1)`,
		s.namespace).Scan(&retainedBytes); err != nil || stats.RetainedBytes != retainedBytes {
		t.Fatalf("retained byte accounting: %d != %d: %v", stats.RetainedBytes, retainedBytes, err)
	}
	if _, err := q.Finish(t.Context(), webhookJobFence(first), wg.Outcome{State: wg.Succeeded, AcceptedStatus: 204}); err != nil {
		t.Fatal(err)
	}
	next := claimWebhook(t, q)
	expireWebhookLease(t, s, next.ID)
	stats, err = q.QueueStats(t.Context())
	if err != nil || stats.Depth != 2 || stats.ActiveWorkers != 0 || stats.RetainedRows != 5 || stats.RetainedBytes != retainedBytes {
		t.Fatalf("terminal retention / expired worker stats: %+v %v", stats, err)
	}
	isolated, _ := testStore(t, Config{})
	other := openWebhook(t, isolated, webhookOptions())
	stats, err = other.QueueStats(t.Context())
	if err != nil || stats.Depth != 0 || stats.RetainedRows != 0 {
		t.Fatalf("stats namespace isolation: %+v %v", stats, err)
	}
}

func TestWebhookTenantByteUtilizationUsesTighterBudget(t *testing.T) {
	s, _ := testStore(t, Config{})
	options := webhookOptions()
	options.MaxTenantBytes = 16384
	q := openWebhook(t, s, options)
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	stats, err := q.QueueStats(t.Context())
	if err != nil || len(stats.TenantUtilization) != 1 {
		t.Fatalf("stats: %+v %v", stats, err)
	}
	expected := float64(stats.RetainedBytes) / float64(options.MaxTenantBytes)
	if stats.TenantUtilization[0] != expected || expected <= 2.0/float64(options.MaxTenantRows) {
		t.Fatalf("byte utilization: %v want %v", stats.TenantUtilization, expected)
	}
}
