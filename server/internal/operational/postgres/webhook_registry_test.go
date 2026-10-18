package postgres

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestWebhookRegistryCASAndAtomicRevisionFencing(t *testing.T) {
	s, dsn := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	control := webhookPolicy()
	first, err := q.BindRegistry(t.Context(), control)
	if err != nil {
		t.Fatal(err)
	}
	record := wg.RepositoryInventory{RepositoryID: 20, OwnerID: 50, OwnerType: "Organization",
		Visibility: "private", CommitSHA: strings.Repeat("c", 40), CheckedAt: time.Now().UTC(), AttemptedAt: time.Now().UTC()}
	active, err := q.ReplaceRegistry(t.Context(), control, first.Version, []wg.RepositoryInventory{record})
	if err != nil || active.Revision.Revision <= first.Revision.Revision {
		t.Fatal("routing publication did not advance effective revision", err)
	}
	admission := webhookAdmission("registry-delivery", webhookJob("registry-job", "tenant"))
	admission.Revision, admission.Jobs[0].QueueRevision = active.Revision, active.Revision
	if _, err := q.AdmitBatch(t.Context(), admission); err != nil {
		t.Fatal(err)
	}
	claimed := claimWebhook(t, q)
	record.CheckedAt, record.AttemptedAt = record.CheckedAt.Add(time.Second), record.AttemptedAt.Add(time.Second)
	refreshed, err := q.ReplaceRegistry(t.Context(), control, active.Version, []wg.RepositoryInventory{record})
	if err != nil || refreshed.Revision != active.Revision || refreshed.Version <= active.Version {
		t.Fatal("freshness-only refresh changed routing or failed to fence stale writers", err)
	}
	if _, err := q.ReplaceRegistry(t.Context(), control, active.Version, nil); !errors.Is(err, wg.ErrConflict) {
		t.Fatal("stale refresh overwrote current inventory", err)
	}
	record.Dirty, record.Workflows = true, nil
	dirty, err := q.ReplaceRegistry(t.Context(), control, refreshed.Version, []wg.RepositoryInventory{record})
	if err != nil || dirty.Revision.Revision <= refreshed.Revision.Revision {
		t.Fatal("hint failed to revoke routing atomically", err)
	}
	var state string
	err = s.db.QueryRowContext(t.Context(), `SELECT state FROM cao_operational_webhook_jobs
		WHERE namespace=$1 AND queue=$2 AND id=$3`, s.namespace, q.name, claimed.ID).Scan(&state)
	if err != nil || state != string(wg.Cancelled) {
		t.Fatalf("old claimed work survived committed invalidation: %s %v", state, err)
	}
	if _, err := q.BeginDispatch(t.Context(), webhookJobFence(claimed), webhookAuthorization(claimed)); err == nil {
		t.Fatal("stale claimed worker crossed invalidation")
	}
	restarted, err := Open(t.Context(), dsn, s.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restarted.Close() }()
	reopened, err := restarted.OpenWebhookQueue(t.Context(), "webhooks", webhookOptions())
	if err != nil {
		t.Fatal(err)
	}
	restored, err := reopened.(wg.RegistryStore).BindRegistry(t.Context(), control)
	if err != nil || !reflect.DeepEqual(restored, dirty) {
		t.Fatal("restart lost registry or monotonic effective revision", err)
	}
	control.Revision++
	control.Enabled = false
	control.Digest = strings.Repeat("b", 64)
	disabled, err := q.BindRegistry(t.Context(), control)
	if err != nil || disabled.Revision.Enabled || len(disabled.Records) != 0 {
		t.Fatal("policy disable failed to clear discovered authority", err)
	}
	if _, err := q.BindRegistry(t.Context(), webhookPolicy()); !errors.Is(err, wg.ErrConflict) {
		t.Fatal("old control policy rolled back registry", err)
	}
}

func TestWebhookRegistryCapacityRollsBackInventoryAndQueueRevision(t *testing.T) {
	s, _ := testStore(t, Config{MaxRecordBytes: 2048})
	q := openWebhook(t, s, webhookOptions())
	control := webhookPolicy()
	before, err := q.BindRegistry(t.Context(), control)
	if err != nil {
		t.Fatal(err)
	}
	record := wg.RepositoryInventory{RepositoryID: 20, Visibility: strings.Repeat("x", 4096)}
	if _, err := q.ReplaceRegistry(t.Context(), control, before.Version, []wg.RepositoryInventory{record}); !errors.Is(err, wg.ErrCapacity) {
		t.Fatal("oversized registry did not fail closed", err)
	}
	after, err := q.BindRegistry(t.Context(), control)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("failed publication partly changed registry or queue policy", err)
	}
}

func TestWebhookRegistryReviewedRevisionRevokesIncompatibleProjection(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	control := webhookPolicy()
	first, err := q.BindRegistry(t.Context(), control)
	if err != nil {
		t.Fatal(err)
	}
	record := wg.RepositoryInventory{RepositoryID: 20, OwnerID: 50, OwnerType: "Organization",
		Visibility: "private", CommitSHA: strings.Repeat("c", 40), CheckedAt: time.Now().UTC()}
	active, err := q.ReplaceRegistry(t.Context(), control, first.Version, []wg.RepositoryInventory{record})
	if err != nil {
		t.Fatal(err)
	}
	admission := webhookAdmission("legacy-delivery", webhookJob("legacy-job", "tenant"))
	admission.Revision, admission.Jobs[0].QueueRevision = active.Revision, active.Revision
	if _, err := q.AdmitBatch(t.Context(), admission); err != nil {
		t.Fatal(err)
	}
	claimed := claimWebhook(t, q)
	active.Records[0].Workflows = []wg.DiscoveredWorkflow{{
		Path: ".github/workflows/old.lock.yml", SHA256: strings.Repeat("d", 64),
		Triggers: []wg.CompilerTrigger{{SchemaVersion: 2, Event: "dependabot_alert",
			Dispatch: wg.CompilerDispatch{PayloadProjection: &wg.CompilerProjection{Policy: "obsolete/v1"}}}},
	}}
	data, err := json.Marshal(active)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.transact(t.Context(), func(tx *transaction) error {
		return tx.put(key{"state", "webhook-gateway:registry:" + q.name, ""}, data, time.Time{})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.BindRegistry(t.Context(), control); !errors.Is(err, wg.ErrInvalid) {
		t.Fatal("incompatible projection remained active", err)
	}
	if _, err := q.ReplaceRegistry(t.Context(), control, active.Version, nil); !errors.Is(err, wg.ErrInvalid) {
		t.Fatal("same control revision bypassed incompatible metadata", err)
	}
	control.Revision++
	control.Digest = strings.Repeat("e", 64)
	reset, err := q.BindRegistry(t.Context(), control)
	if err != nil || len(reset.Records) != 0 || reset.Version <= active.Version ||
		reset.Revision.Revision <= active.Revision.Revision {
		t.Fatal("reviewed revision could not revoke incompatible inventory", err)
	}
	if _, err := q.BeginDispatch(t.Context(), webhookJobFence(claimed), webhookAuthorization(claimed)); err == nil {
		t.Fatal("old worker survived projection migration")
	}
	current, err := q.BindRegistry(t.Context(), control)
	if err != nil || !reflect.DeepEqual(current, reset) {
		t.Fatal("reset registry did not remain usable", err)
	}
	if _, err := q.BindRegistry(t.Context(), webhookPolicy()); !errors.Is(err, wg.ErrConflict) {
		t.Fatal("old control revision reactivated incompatible metadata", err)
	}
}
