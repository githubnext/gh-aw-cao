package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
	"github.com/githubnext/gh-aw-cao/server/internal/webhookgatewaylocal"
)

type specStep struct {
	Op, Error, Delivery, Reason string
	State                       wg.JobState
	Batch, Count                int
	Duplicate, Empty            bool
}

type specCase struct {
	ID                       string
	Rows, Rate, WorkflowRate int
	Steps                    []specStep
}

type queueRig struct {
	q                 *Queue
	path, namespace   string
	options           wg.QueueOptions
	revision          wg.QueueRevision
	simulation        *webhookgatewaylocal.Simulation
	subscription      wg.Subscription
	digest            string
	current, previous wg.Job
	markedBudget      float64
}

func newRig(t *testing.T, c specCase) *queueRig {
	t.Helper()
	repository := webhookgatewaylocal.Repository{ID: 42, FullName: "octo/repo"}
	repository.Owner.ID, repository.Owner.Type = 7, "Organization"
	simulation, err := webhookgatewaylocal.NewSimulation(repository, []string{"issues"})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := simulation.Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	options := policy.Policy.Queue
	if c.Rows > 0 {
		options.MaxRows = int64(c.Rows)
		options.MaxTenantRows, options.MaxSourceRows, options.MaxDestinationRows = options.MaxRows, options.MaxRows, options.MaxRows
	}
	if c.Rate > 0 {
		budget := wg.RateBudget{Capacity: c.Rate, Period: time.Hour}
		options.Rates = wg.RateBudgets{Global: budget, App: budget, Tenant: budget, Destination: budget, Workflow: budget}
	}
	if c.WorkflowRate > 0 {
		options.Rates.Workflow.Capacity = c.WorkflowRate
	}
	rig := &queueRig{path: filepath.Join(t.TempDir(), "gateway.sqlite"), namespace: policy.Policy.Namespace,
		options: options, revision: policy.Revision, simulation: simulation, subscription: policy.Subscriptions[0],
		digest: policy.Revisions[policy.Subscriptions[0].ID].Digest}
	rig.open(t)
	t.Cleanup(func() {
		if err := rig.q.Close(); err != nil {
			t.Error(err)
		}
	})
	return rig
}

func (r *queueRig) open(t *testing.T) {
	t.Helper()
	var err error
	r.q, err = Open(t.Context(), r.path, r.namespace, r.options)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.q.ApplyRevision(t.Context(), r.revision); err != nil {
		t.Fatal(err)
	}
}

func (r *queueRig) admission(t *testing.T, delivery string, batch int) wg.Admission {
	t.Helper()
	if delivery == "" {
		delivery = "delivery"
	}
	admission := wg.Admission{Revision: r.revision, DeliveryID: delivery, DeliveryDigest: wg.MetadataDigest([]byte(delivery))}
	admission.Revision.Enabled = true
	for i := range max(1, batch) {
		sub := r.subscription
		if i > 0 {
			sub.ID += "-" + strconv.Itoa(i)
		}
		event := wg.Event{SourceID: "local", DeliveryID: delivery, Name: "issues", Action: "opened",
			InstallationID: 1, RepositoryID: 42, OrganizationID: 7,
			Payload: json.RawMessage(`{"action":"opened","installation":{"id":1},"repository":{"id":42},"organization":{"id":7},"private_body":"never-persist-raw"}`)}
		job, err := wg.NewJob(time.Now().Add(-time.Millisecond), "input-"+strconv.Itoa(i), event, sub, r.digest)
		if err != nil {
			t.Fatal(err)
		}
		admission.Jobs = append(admission.Jobs, job)
	}
	return admission
}

func jobFence(job wg.Job) wg.Fence {
	return wg.Fence{JobID: job.ID, Owner: job.ClaimID, Generation: job.Fence, Version: job.Version}
}

func TestSpecQueueTraces(t *testing.T) {
	data, err := os.ReadFile("../../../../specs/fixtures/local-gateway-queue.json")
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Version int
		Cases   []specCase
	}
	if err := json.Unmarshal(data, &suite); err != nil || suite.Version != 1 || len(suite.Cases) == 0 {
		t.Fatal("invalid specification trace suite", err)
	}
	spec, err := os.ReadFile("../../../../specs/rfc-034-local-webhook-gateway.md")
	if err != nil {
		t.Fatal(err)
	}
	requirements := map[string]bool{}
	for _, c := range suite.Cases {
		if requirements[c.ID] || !strings.Contains(string(spec), "**"+c.ID+"**") {
			t.Fatal("duplicate or unspecified requirement", c.ID)
		}
		requirements[c.ID] = true
		t.Run(c.ID, func(t *testing.T) {
			rig := newRig(t, c)
			for i, step := range c.Steps {
				err := rig.step(t, step)
				want := map[string]error{"conflict": wg.ErrConflict, "capacity": wg.ErrCapacity,
					"unauthorized": wg.ErrUnauthorized, "invalid": wg.ErrInvalid}[step.Error]
				if (step.Error != "" && want == nil) || !errors.Is(err, want) {
					t.Fatalf("step %d %s: got %v, want %s", i, step.Op, err, step.Error)
				}
			}
		})
	}
	for i := 1; i <= 13; i++ {
		if id := "LG-Q" + twoDigits(i); !requirements[id] {
			t.Fatal("missing normative queue requirement", id)
		}
	}
}

func twoDigits(i int) string {
	if i < 10 {
		return "0" + strconv.Itoa(i)
	}
	return strconv.Itoa(i)
}

func (r *queueRig) step(t *testing.T, step specStep) error {
	t.Helper()
	ctx := t.Context()
	switch step.Op {
	case "admit", "admit-conflict":
		admission := r.admission(t, step.Delivery, step.Batch)
		if step.Op == "admit-conflict" {
			admission.DeliveryDigest = wg.MetadataDigest([]byte("different"))
		}
		previouslyRecorded, err := r.q.HasDelivery(ctx, admission.DeliveryID)
		if err != nil {
			t.Fatal(err)
		}
		result, err := r.q.AdmitBatch(ctx, admission)
		if recorded, lookupErr := r.q.HasDelivery(ctx, admission.DeliveryID); lookupErr != nil ||
			recorded != (previouslyRecorded || err == nil) {
			t.Fatal("receipt does not reflect atomic admission", recorded, lookupErr)
		}
		if err == nil && result.Duplicate != step.Duplicate {
			t.Fatalf("duplicate=%v, want %v", result.Duplicate, step.Duplicate)
		}
		if err == nil && len(result.Jobs) > 0 {
			r.current = result.Jobs[0]
		}
		return err
	case "restart":
		if err := r.q.Close(); err != nil {
			return err
		}
		r.open(t)
		return nil
	case "claim":
		job, err := r.q.Claim(ctx, wg.ClaimRequest{Owner: "worker", LeaseDuration: time.Minute})
		if err == nil && (job == nil) != step.Empty {
			t.Fatalf("empty claim=%v, want %v", job == nil, step.Empty)
		}
		if job != nil {
			r.previous, r.current = r.current, *job
		}
		return err
	case "renew":
		job, err := r.q.Renew(ctx, jobFence(r.current), time.Minute)
		if err == nil {
			r.previous, r.current = r.current, job
		}
		return err
	case "begin", "begin-stale":
		job := r.current
		if step.Op == "begin-stale" {
			job = r.previous
		}
		auth, err := r.simulation.Authorize(ctx, job)
		if err != nil {
			return err
		}
		next, err := r.q.BeginDispatch(ctx, jobFence(job), wg.Authorization{Revision: r.revision,
			ApprovedSubscriptionDigest: r.digest, Snapshot: auth})
		if err == nil {
			r.previous, r.current = r.current, next
		}
		return err
	case "finish", "finish-stale":
		job := r.current
		if step.Op == "finish-stale" {
			job = r.previous
		}
		outcome := wg.Outcome{State: step.State, Reason: step.Reason}
		if step.State == wg.Succeeded {
			outcome.AcceptedStatus = 204
		}
		next, err := r.q.Finish(ctx, jobFence(job), outcome)
		if err == nil {
			r.previous, r.current = r.current, next
		}
		return err
	case "disable", "advance-revision", "revision-conflict", "revision-rollback":
		next := r.revision
		switch step.Op {
		case "disable":
			next.Revision++
			next.Enabled = false
		case "advance-revision":
			next.Revision++
		case "revision-conflict":
			next.Digest = wg.MetadataDigest([]byte("conflicting"))
		case "revision-rollback":
			next.Revision--
		}
		err := r.q.ApplyRevision(ctx, next)
		if err == nil {
			r.revision = next
		}
		return err
	case "elapse-lease", "elapse-ttl", "elapse-retention":
		// Explicit clock-environment fault injection; queue operations still use
		// SQLite time, and crash/restart steps reopen the actual database file.
		return r.q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
			if step.Op == "elapse-retention" {
				if _, err := tx.ExecContext(ctx, `UPDATE jobs SET retain_until=0`); err != nil {
					return err
				}
				_, err := tx.ExecContext(ctx, `UPDATE deliveries SET retain_until=0`)
				return err
			}
			ids, err := selectIDs(ctx, tx, `SELECT id FROM jobs`)
			if err != nil {
				return err
			}
			for _, id := range ids {
				job, err := load(ctx, tx, id)
				if err != nil {
					return err
				}
				if step.Op == "elapse-lease" {
					job.LeaseUntil = now.Add(-time.Second)
				} else {
					job.CreatedAt, job.ExpiresAt = now.Add(-time.Hour), now.Add(-time.Second)
				}
				if err := r.q.save(ctx, tx, now, job); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `UPDATE jobs SET created_at=?,expires_at=? WHERE id=?`,
					job.CreatedAt.UnixMilli(), job.ExpiresAt.UnixMilli(), id); err != nil {
					return err
				}
			}
			return nil
		})
	case "maintain":
		_, err := r.q.Maintain(ctx, 100)
		return err
	case "counts":
		counts, err := r.q.Counts(ctx)
		if err == nil && counts[step.State] != int64(step.Count) {
			t.Fatalf("%s count=%d, want %d", step.State, counts[step.State], step.Count)
		}
		return err
	case "mark-budget", "budget-unchanged":
		key := wg.MetadataDigest([]byte(`["global",""]`))
		var tokens float64
		if err := r.q.db.QueryRowContext(ctx, `SELECT tokens FROM rates WHERE id=?`, key).Scan(&tokens); err != nil {
			return err
		}
		if step.Op == "mark-budget" {
			r.markedBudget = tokens
		} else if tokens != r.markedBudget {
			t.Fatal("failed hierarchical reservation partially spent a token")
		}
		return nil
	case "attempts":
		return r.q.transact(ctx, func(tx *sql.Tx, _ time.Time) error {
			job, err := load(ctx, tx, r.current.ID)
			if err == nil && int64(job.Attempt) != int64(step.Count) {
				t.Fatal("failed reservation consumed an attempt", job.Attempt)
			}
			return err
		})
	default:
		t.Fatal("unknown specification operation", step.Op)
		return wg.ErrInvalid
	}
}

func TestCrossConnectionClaimsAndCancellation(t *testing.T) {
	r := newRig(t, specCase{})
	if _, err := r.q.AdmitBatch(t.Context(), r.admission(t, "", 1)); err != nil {
		t.Fatal(err)
	}
	other, err := Open(t.Context(), r.path, r.namespace, r.options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	var workers sync.WaitGroup
	results := make(chan *wg.Job, 2)
	for _, queue := range []*Queue{r.q, other} {
		workers.Go(func() {
			job, err := queue.Claim(t.Context(), wg.ClaimRequest{Owner: "concurrent", LeaseDuration: time.Minute})
			if err != nil {
				t.Error(err)
			}
			results <- job
		})
	}
	workers.Wait()
	close(results)
	claimed := 0
	for job := range results {
		if job != nil {
			claimed++
		}
	}
	if claimed != 1 {
		t.Fatal("expected one exclusive claim", claimed)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := other.AdmitBatch(ctx, r.admission(t, "cancelled", 1)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled transaction committed", err)
	}
	data, err := os.ReadFile(r.path)
	if err != nil || strings.Contains(string(data), "never-persist-raw") {
		t.Fatal("raw event persisted", err)
	}
}

func TestDatabaseConfigurationCannotBeRebound(t *testing.T) {
	r := newRig(t, specCase{})
	info, err := os.Stat(r.path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("SQLite database was not created privately", err)
	}
	if _, err := Open(t.Context(), r.path, "another-namespace", r.options); !errors.Is(err, wg.ErrConflict) {
		t.Fatal("namespace rebound", err)
	}
	if err := os.Chmod(r.path, 0644); err != nil { // #nosec G302 -- negative test: opening a non-private database must fail.
		t.Fatal(err)
	}
	if _, err := Open(t.Context(), r.path, r.namespace, r.options); !errors.Is(err, wg.ErrInvalid) {
		t.Fatal("public database accepted", err)
	}
}

func TestReceiptAndFanoutExactByteBoundary(t *testing.T) {
	r := newRig(t, specCase{})
	admission := r.admission(t, "", 2)
	for i := range admission.Jobs {
		admission.Jobs[i].NotBefore = admission.Jobs[i].CreatedAt.Add(time.Minute)
	}
	if _, err := r.q.AdmitBatch(t.Context(), admission); err != nil {
		t.Fatal(err)
	}
	var required int64
	if err := r.q.db.QueryRowContext(t.Context(), `SELECT
	 (SELECT sum(bytes) FROM jobs)+(SELECT sum(bytes) FROM deliveries)`).Scan(&required); err != nil {
		t.Fatal(err)
	}
	for _, adjustment := range []int64{-1, 0} {
		t.Run(strconv.FormatInt(adjustment, 10), func(t *testing.T) {
			options := r.options
			options.MaxBytes = required + adjustment
			options.MaxTenantBytes, options.MaxSourceBytes, options.MaxDestinationBytes = options.MaxBytes, options.MaxBytes, options.MaxBytes
			queue, err := Open(t.Context(), filepath.Join(t.TempDir(), "bounded.sqlite"), r.namespace, options)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = queue.Close() }()
			if err := queue.ApplyRevision(t.Context(), r.revision); err != nil {
				t.Fatal(err)
			}
			_, err = queue.AdmitBatch(t.Context(), admission)
			if adjustment < 0 {
				if !errors.Is(err, wg.ErrCapacity) {
					t.Fatal("batch exceeded exact byte ceiling", err)
				}
				var receipts int
				if err := queue.db.QueryRowContext(t.Context(), `SELECT count(*) FROM deliveries`).Scan(&receipts); err != nil || receipts != 0 {
					t.Fatal("failed byte admission retained a partial receipt", receipts, err)
				}
			} else if err != nil {
				t.Fatal("exactly bounded batch was rejected", err)
			}
		})
	}
}

func TestConcurrencyAndTenantFairness(t *testing.T) {
	r := newRig(t, specCase{})
	admission := r.admission(t, "", 3)
	admission.Jobs[2].Subscription.TenantID = "other"
	result, err := r.q.AdmitBatch(t.Context(), admission)
	if err != nil {
		t.Fatal(err)
	}
	var firstTenant string
	for i := range r.options.MaxConcurrency {
		job, err := r.q.Claim(t.Context(), wg.ClaimRequest{Owner: "worker-" + strconv.Itoa(i), LeaseDuration: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if i < len(result.Jobs) && job == nil {
			t.Fatal("job unavailable below concurrency limit")
		}
		if i == 0 {
			firstTenant = job.Subscription.TenantID
		} else if i == 1 && job.Subscription.TenantID == firstTenant {
			t.Fatal("claim did not rotate tenants")
		}
	}
	// All existing claims count toward admission, even across worker owners.
	for i := 3; i < r.options.MaxConcurrency+1; i++ {
		if _, err := r.q.AdmitBatch(t.Context(), r.admission(t, "extra-"+strconv.Itoa(i), 1)); err != nil {
			t.Fatal(err)
		}
	}
	for range r.options.MaxConcurrency - 3 {
		if job, err := r.q.Claim(t.Context(), wg.ClaimRequest{Owner: "fill", LeaseDuration: time.Minute}); err != nil || job == nil {
			t.Fatal("failed to fill concurrency slots", err)
		}
	}
	if job, err := r.q.Claim(t.Context(), wg.ClaimRequest{Owner: "excess", LeaseDuration: time.Minute}); err != nil || job != nil {
		t.Fatal("concurrency limit exceeded", err)
	}
}
