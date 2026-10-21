package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

func conclusionFixture() (admission.Identity, admission.ConclusionRequest) {
	i := admission.Identity{
		Issuer: admission.Issuer, Repository: "acme/project", RepositoryID: "1001", OwnerID: "42",
		Actor: "octocat", ActorID: "101", RunID: "1234", RunAttempt: "2", Ref: "refs/heads/main",
		Subject: "repo:acme/project:ref:refs/heads/main", Event: "workflow_dispatch",
		WorkflowRef: "acme/project/.github/workflows/triage.lock.yml@refs/heads/main", WorkflowSHA: strings.Repeat("a", 40),
	}
	return i, admission.ConclusionRequest{
		Request: admission.Request{
			Repo: i.Repository, WorkflowID: i.WorkflowRef, RunID: i.RunID, RunAttempt: i.RunAttempt,
			WorkflowHash:   strings.Repeat("a", 64) + ":" + strings.Repeat("b", 64),
			WorkflowCallID: i.RunID + "-" + i.RunAttempt + ":" + i.WorkflowRef,
			Ref:            i.Ref, EventType: i.Event, Actor: i.Actor, TriggeringActor: "hubot",
		},
		Session:           "{\"type\":\"session.format\",\"data\":{\"version\":1}}\n",
		SessionCompaction: admission.SessionCompaction{Version: 1, IncludedEvents: 1},
		UsageArtifactIDs:  []string{"99999999999999999999"},
	}
}

func TestConclusionReplicaRetryConflictAndIsolation(t *testing.T) {
	store, dsn := testStore(t, Config{})
	replica, err := Open(t.Context(), dsn, store.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = replica.Close() }()
	i, input := conclusionFixture()
	var group sync.WaitGroup
	for n := 0; n < 20; n++ {
		group.Go(func() {
			if _, err := replica.RecordConclusion(t.Context(), i, input); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	var beforeBytes int64
	if err := store.db.QueryRowContext(t.Context(), `SELECT protected_bytes FROM cao_operational_namespaces WHERE namespace=$1`, store.namespace).Scan(&beforeBytes); err != nil {
		t.Fatal(err)
	}
	modified := input
	modified.UsageArtifactIDs = []string{"2"}
	if _, err := replica.RecordConclusion(t.Context(), i, modified); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("conflicting payload overwritten: %v", err)
	}
	if _, err := store.RecordConclusion(t.Context(), i, input); err != nil {
		t.Fatalf("lost acknowledgement recovery: %v", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := store.RecordConclusion(cancelled, i, input); !errors.Is(err, admission.ErrUnavailable) {
		t.Fatalf("outage acknowledged: %v", err)
	}
	if _, err := store.RecordConclusion(t.Context(), i, input); err != nil {
		t.Fatal(err)
	}
	var count, afterBytes int64
	if err := store.db.QueryRowContext(t.Context(), `SELECT protected_bytes,protected_entries FROM cao_operational_namespaces WHERE namespace=$1`, store.namespace).Scan(&afterBytes, &count); err != nil {
		t.Fatal(err)
	}
	if afterBytes != beforeBytes || count != 2 {
		t.Fatal("retries allocated duplicate work or replaced records")
	}
	err = store.transact(t.Context(), func(tx *transaction) error {
		var saved conclusionRecord
		found, err := tx.json(key{"conclusion-session", i.Key(), ""}, &saved)
		if !found || saved.Request.UsageArtifactIDs[0] != input.UsageArtifactIDs[0] ||
			saved.Request.Session != input.Session || saved.Identity.WorkflowSHA != i.WorkflowSHA ||
			saved.AcceptedAt.IsZero() {
			t.Error("accepted record lost authenticated identity or original payload")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	// Operations and independently verified invocations never share receipts.
	allowance := admission.Allowances{Primary: 1}
	if _, err := store.ResolveAdmission(t.Context(), i.Key(), &allowance); err != nil {
		t.Fatal("conclusion changed activation decision")
	}
	for _, change := range []func(*admission.Identity){
		func(i *admission.Identity) { i.RepositoryID = "1002" },
		func(i *admission.Identity) { i.OwnerID = "43" },
		func(i *admission.Identity) { i.RunAttempt = "3" },
		func(i *admission.Identity) { i.WorkflowSHA = strings.Repeat("b", 40) },
	} {
		other := i
		change(&other)
		if _, err := store.RecordConclusion(t.Context(), other, modified); err != nil {
			t.Fatal("independent invocation collided")
		}
	}
	isolated, _ := testStore(t, Config{})
	if _, err := isolated.RecordConclusion(t.Context(), i, modified); err != nil {
		t.Fatal("deployment namespaces shared sessions")
	}
}

func TestConclusionRetentionAndPermanentReceipt(t *testing.T) {
	store, _ := testStore(t, Config{MaxProtectedEntries: 2})
	i, input := conclusionFixture()
	first, err := store.RecordConclusion(t.Context(), i, input)
	if err != nil || first.AcceptedAt.IsZero() || first.Populated {
		t.Fatal(err)
	}
	var expiry time.Time
	if err := store.db.QueryRowContext(t.Context(), `SELECT expires_at FROM cao_operational_records WHERE namespace=$1 AND kind='conclusion-session'`, store.namespace).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(expiry); remaining > conclusionRetention || remaining < conclusionRetention-time.Minute {
		t.Fatal("session retention not bounded to 24 hours")
	}
	retried, err := store.RecordConclusion(t.Context(), i, input)
	if err != nil || !first.AcceptedAt.Equal(retried.AcceptedAt) || retried.Populated {
		t.Fatal(err)
	}
	var retriedExpiry time.Time
	if err := store.db.QueryRowContext(t.Context(), `SELECT expires_at FROM cao_operational_records WHERE namespace=$1 AND kind='conclusion-session'`, store.namespace).Scan(&retriedExpiry); err != nil {
		t.Fatal(err)
	}
	if !retriedExpiry.Equal(expiry) {
		t.Fatal("retry extended sensitive payload retention")
	}
	if err := store.CompleteConclusion(t.Context(), i); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `UPDATE cao_operational_records SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND kind='conclusion-session'`, store.namespace); err != nil {
		t.Fatal(err)
	}
	if err := store.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	completed, err := store.RecordConclusion(t.Context(), i, input)
	if err != nil || !completed.Populated || !completed.AcceptedAt.Equal(first.AcceptedAt) {
		t.Fatal("identical late retry not acknowledged")
	}
	var records int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_operational_records WHERE namespace=$1 AND kind='conclusion-session'`, store.namespace).Scan(&records); err != nil || records != 0 {
		t.Fatal("late replay recreated expired payload or processing")
	}
	input.Session = ""
	input.SessionCompaction.IncludedEvents = 0
	if _, err := store.RecordConclusion(t.Context(), i, input); !errors.Is(err, admission.ErrDenied) {
		t.Fatal("expired payload lost immutable conflict receipt")
	}
	i.RunAttempt = "3"
	if _, err := store.RecordConclusion(t.Context(), i, input); !errors.Is(err, admission.ErrUnavailable) {
		t.Fatal("protected capacity silently evicted tombstones")
	}
}

func TestConclusionCapacityRollsBackPayloadAndReceipt(t *testing.T) {
	store, _ := testStore(t, Config{MaxProtectedEntries: 1})
	i, input := conclusionFixture()
	if _, err := store.RecordConclusion(t.Context(), i, input); !errors.Is(err, admission.ErrUnavailable) {
		t.Fatal("partial durable acceptance")
	}

	var bytes, entries int64
	if err := store.db.QueryRowContext(t.Context(), `SELECT protected_bytes,protected_entries FROM cao_operational_namespaces WHERE namespace=$1`, store.namespace).Scan(&bytes, &entries); err != nil || bytes != 0 || entries != 0 {
		t.Fatal("failed receipt left payload or budget allocation")
	}
}

func TestConclusionPendingExpiryCannotRecreatePopulation(t *testing.T) {
	store, _ := testStore(t, Config{})
	identity, input := conclusionFixture()
	if err := store.CompleteConclusion(t.Context(), identity); !errors.Is(err, admission.ErrDenied) {
		t.Fatal("unknown receipt marked populated")
	}
	if _, err := store.RecordConclusion(t.Context(), identity, input); err != nil {
		t.Fatal(err)
	}
	if err := store.transact(t.Context(), func(tx *transaction) error {
		key := key{"conclusion-receipt", identity.Key(), ""}
		var receipt conclusionReceipt
		if _, err := tx.json(key, &receipt); err != nil {
			return err
		}
		receipt.AcceptedAt = tx.now.Add(-conclusionRetention - time.Second)
		return tx.putJSON(key, receipt, time.Time{})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordConclusion(t.Context(), identity, input); !errors.Is(err, admission.ErrDenied) {
		t.Fatal("expired pending callback restarted population")
	}
	if err := store.CompleteConclusion(t.Context(), identity); !errors.Is(err, admission.ErrDenied) {
		t.Fatal("expired pending callback marked complete")
	}
}
