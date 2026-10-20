package postgres

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func webhookOverlappingJobs() []wg.Job {
	repository := webhookJob("repository", "tenant-a")
	organization := webhookJob("organization", "tenant-b")
	organization.Subscription.Source.OrganizationID = 50
	payload := []byte(`{"installation":{"id":10},"repository":{"id":20},"organization":{"id":50}}`)
	repository.Payload, organization.Payload = payload, payload
	return []wg.Job{repository, organization}
}

func TestWebhookGenericFanoutAcrossTenantAndSourceScopes(t *testing.T) {
	s, _ := testStore(t, Config{})
	options := webhookOptions()
	options.MaxTenantRows, options.MaxSourceRows = 2, 2
	q := openWebhook(t, s, options)
	jobs := webhookOverlappingJobs()
	result, err := q.AdmitBatch(t.Context(), webhookAdmission("delivery", jobs...))
	if err != nil || len(result.Jobs) != 2 {
		t.Fatalf("overlapping generic fanout: %+v %v", result, err)
	}
	for _, job := range result.Jobs {
		d := wg.JobDimensions(job)
		var count int
		if err := s.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_operational_webhook_deliveries WHERE namespace=$1 AND $2=ANY(tenants) AND $3=ANY(sources)`,
			s.namespace, d.Tenant, d.Source).Scan(&count); err != nil || count != 1 {
			t.Fatalf("receipt dimension accounting: %d %v", count, err)
		}
	}
	stats, err := q.QueueStats(t.Context())
	if err != nil || stats.RetainedRows != 3 || len(stats.TenantUtilization) != 2 ||
		stats.TenantUtilization[0] != 1 || stats.TenantUtilization[1] != 1 {
		t.Fatalf("heterogeneous receipt telemetry accounting: %+v %v", stats, err)
	}
	var beforeBytes, beforeRows int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT protected_bytes,protected_entries FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&beforeBytes, &beforeRows); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AdmitBatch(t.Context(), webhookAdmission("overflow", webhookOverlappingJobs()...)); !errors.Is(err, wg.ErrCapacity) {
		t.Fatalf("fanout scopes bypassed retained capacity: %v", err)
	}
	var afterBytes, afterRows int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT protected_bytes,protected_entries FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&afterBytes, &afterRows); err != nil {
		t.Fatal(err)
	}
	if afterBytes != beforeBytes || afterRows != beforeRows {
		t.Fatalf("partial failed fanout accounting: %d/%d -> %d/%d", beforeBytes, beforeRows, afterBytes, afterRows)
	}
	for range 2 {
		job := dispatchWebhook(t, q, claimWebhook(t, q))
		if _, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: wg.Succeeded, AcceptedStatus: 204}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWebhookHeterogeneousFanoutRollbackOnLaterGroup(t *testing.T) {
	s, _ := testStore(t, Config{})
	options := webhookOptions()
	options.MaxDestinationRows = 1
	q := openWebhook(t, s, options)
	if _, err := q.AdmitBatch(t.Context(), webhookAdmission("delivery", webhookOverlappingJobs()...)); !errors.Is(err, wg.ErrCapacity) {
		t.Fatalf("later fanout group capacity: %v", err)
	}
	var rows int
	if err := s.db.QueryRowContext(t.Context(), `SELECT
		(SELECT count(*) FROM cao_operational_webhook_jobs WHERE namespace=$1)+
		(SELECT count(*) FROM cao_operational_webhook_deliveries WHERE namespace=$1)`, s.namespace).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("partial heterogeneous fanout persisted: %d %v", rows, err)
	}
}

func TestWebhookOrganizationSourceRejectsRepositoryFanoutAtomically(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	jobs := webhookOverlappingJobs()
	jobs[1].Subscription.Source.RepositoryID = 0
	if _, err := q.AdmitBatch(t.Context(), webhookAdmission("delivery", jobs...)); !errors.Is(err, wg.ErrInvalid) {
		t.Fatalf("organization-only source admitted repository event: %v", err)
	}
	var rows int
	if err := s.db.QueryRowContext(t.Context(), `SELECT
		(SELECT count(*) FROM cao_operational_webhook_jobs WHERE namespace=$1)+
		(SELECT count(*) FROM cao_operational_webhook_deliveries WHERE namespace=$1)`, s.namespace).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("invalid source left partial fanout: %d %v", rows, err)
	}
}

func TestWebhookLegacyOrganizationJobDoesNotBlockFollowingWork(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	legacy, valid := webhookJob("legacy", "a"), webhookJob("valid", "z")
	legacy.Subscription.Destination.BatchInput = true
	valid.Subscription.Destination.BatchInput = true
	jobs := admitWebhook(t, q, "delivery", legacy, valid)
	legacy = jobs[0]
	legacy.Subscription.Source.RepositoryID = 0
	legacy.Subscription.Source.OrganizationID = 50
	document, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce a persisted job that the previous wildcard contract admitted.
	if _, err := s.db.ExecContext(t.Context(), `UPDATE cao_operational_webhook_jobs SET document=$3
		WHERE namespace=$1 AND id=$2`, s.namespace, legacy.ID, document); err != nil {
		t.Fatal(err)
	}
	request := wg.ClaimRequest{Owner: "worker", LeaseDuration: time.Minute}
	claimed, err := q.ClaimBatch(t.Context(), request)
	if err != nil || len(claimed) != 1 || claimed[0].ID != legacy.ID {
		t.Fatalf("legacy job could not be isolated: jobs=%d err=%v", len(claimed), err)
	}
	if _, err := wg.BuildDispatchBatch(claimed); !errors.Is(err, wg.ErrInvalid) {
		t.Fatalf("legacy organization job remained dispatchable: %v", err)
	}
	if _, err := q.Cancel(t.Context(), claimed[0].ID, claimed[0].Version); err != nil {
		t.Fatalf("legacy job could not be cancelled: %v", err)
	}
	claimed, err = q.ClaimBatch(t.Context(), request)
	if err != nil || len(claimed) != 1 || claimed[0].ID != jobs[1].ID {
		t.Fatalf("legacy job blocked following work: jobs=%d err=%v", len(claimed), err)
	}
	if err := wg.ValidateJob(claimed[0]); err != nil {
		t.Fatalf("following valid job lost its identity contract: %v", err)
	}
	if dispatched := dispatchWebhook(t, q, claimed[0]); dispatched.State != wg.Dispatching {
		t.Fatal("following valid job could not reserve dispatch")
	}
}
