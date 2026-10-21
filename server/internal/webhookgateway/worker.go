package webhookgateway

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	servertelemetry "github.com/githubnext/gh-cao/server/internal/telemetry"
)

// Worker owns one fenced same-kind batch at a time. Queue never performs HTTP.
type Worker struct {
	Policies      PolicyProvider
	Queue         Queue
	Authorizer    Authorizer
	Dispatcher    Dispatcher
	Budget        Budget
	Owner         string
	HTTPTimeout   time.Duration
	LeaseDuration time.Duration
	FinishTimeout time.Duration
	PollInterval  time.Duration
	BatchWindow   time.Duration
	LabelConsumer interface {
		ConsumeLabels(context.Context, []Job) error
	}
}

func (w *Worker) durations() (httpTimeout, lease, finish, poll time.Duration) {
	httpTimeout, lease, finish, poll = w.HTTPTimeout, w.LeaseDuration, w.FinishTimeout, w.PollInterval
	if httpTimeout <= 0 {
		httpTimeout = 30 * time.Second
	}
	if finish <= 0 {
		finish = 5 * time.Second
	}
	if lease < httpTimeout+finish+5*time.Second {
		lease = httpTimeout + finish + 5*time.Second
	}
	if poll <= 0 {
		poll = time.Second
	}
	return
}

// Run continues until cancellation. A failure does not spin or abandon recovery.
func (w *Worker) Run(ctx context.Context) error {
	_, _, _, poll := w.durations()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		worked, err := w.RunOnce(ctx)
		if err == nil && worked {
			continue
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// RunOnce returns whether it claimed a batch, not whether GitHub accepted it.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	if w.Policies == nil || w.Queue == nil || w.Authorizer == nil || w.Dispatcher == nil || w.Owner == "" {
		return false, ErrInvalid
	}
	queue, ok := w.Queue.(BatchQueue)
	if !ok {
		return false, ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	ctx, end := gatewayStage(ctx, "worker", "")
	outcome := "error"
	defer func() { end(outcome) }()
	snapshot, err := w.Policies.Load(ctx)
	if err != nil {
		return false, err
	}
	if err := w.Queue.ApplyRevision(ctx, snapshot.Revision); err != nil {
		return false, err
	}
	maintenance, err := w.Queue.Maintain(ctx, 100)
	if err != nil {
		return false, err
	}
	observeGatewayMaintenance(ctx, maintenance)
	if observer, ok := w.Queue.(QueueStatsProvider); ok {
		if stats, err := observer.QueueStats(ctx); err == nil {
			observeGatewayStats(ctx, stats)
		}
	} else if observer, ok := w.Queue.(QueueDepthProvider); ok {
		if depth, err := observer.QueueDepth(ctx); err == nil {
			observeGatewayQueue(ctx, depth)
		}
	}
	if !snapshot.Revision.Enabled {
		outcome = "disabled"
		return false, nil
	}
	httpTimeout, lease, finishTimeout, _ := w.durations()
	claimCtx, claimEnd := gatewayStage(ctx, "claim", "")
	jobs, err := queue.ClaimBatch(claimCtx, ClaimRequest{Owner: w.Owner, LeaseDuration: lease, BatchWindow: w.BatchWindow})
	if errors.Is(err, ErrNotFound) || (err == nil && len(jobs) == 0) {
		claimEnd("empty")
		outcome = "empty"
		return false, nil
	}
	if err != nil {
		claimEnd("error")
		return false, err
	}
	claimEnd("claimed")
	job := &jobs[0]
	ctx, attemptEnd := gatewayStage(servertelemetry.ExtractTraceparent(ctx, job.TraceParent), "attempt", job.Event.Name)
	defer func() { attemptEnd(outcome) }()
	traceGatewayIdentity(ctx, job.DeliveryID, job.ID)
	observeQueueAge(ctx, job.CreatedAt)
	// Reload after claim: the earlier read was only permission to poll.
	snapshot, err = w.Policies.Load(ctx)
	if err != nil {
		return true, err
	}
	if err := w.Queue.ApplyRevision(ctx, snapshot.Revision); err != nil {
		return true, err
	}
	for _, member := range jobs {
		revision, exists := snapshot.Revisions[member.Subscription.ID]
		if !snapshot.Revision.Enabled || !exists || revision.Digest != member.SubscriptionDigest {
			outcome = "cancelled"
			return true, w.cancelBatch(ctx, jobs)
		}
	}
	payload, err := BuildDispatchBatch(jobs)
	if err != nil || ValidateBatchMembers(jobs) != nil {
		outcome = "cancelled"
		return true, errors.Join(ErrInvalid, w.cancelBatch(ctx, jobs))
	}
	if RequiresLabelRemoval(job.Subscription) && w.LabelConsumer == nil {
		return true, ErrUnavailable
	}
	dispatch := w.Dispatcher.Dispatch
	if job.Subscription.Compiler != nil {
		compiler, ok := w.Dispatcher.(CompilerDispatcher)
		revision, err := DispatchRevision(jobs)
		if !ok || err != nil {
			return true, errors.Join(ErrUnavailable, err)
		}
		dispatch = func(ctx context.Context, s Subscription, payload json.RawMessage) DispatchResponse {
			return compiler.DispatchCompiler(ctx, s, payload, revision)
		}
	}
	authCtx, authEnd := gatewayStage(ctx, "authorization", job.Subscription.Source.Event)
	evidence, err := w.authorizeBatch(authCtx, jobs)
	if err != nil {
		authEnd("deferred")
		outcome = "deferred"
		// Unknown authority stays claimed until safe claim recovery or TTL expiry.
		return true, err
	}
	authorizations := make([]Authorization, len(jobs))
	for i, member := range jobs {
		decision, err := ValidateAuthorization(time.Now(), member, evidence[i])
		if err != nil {
			authEnd("error")
			return true, err
		}
		if decision.Cancel {
			authEnd("auth_denied")
			outcome = "cancelled"
			return true, w.cancelBatch(ctx, jobs)
		}
		if !decision.Allowed {
			authEnd("deferred")
			outcome = "deferred"
			return true, nil
		}
		authorizations[i] = Authorization{Revision: snapshot.Revision,
			ApprovedSubscriptionDigest: member.SubscriptionDigest, Snapshot: evidence[i]}
	}
	authEnd("authorized")
	if w.Budget != nil {
		quotaCtx, quotaEnd := gatewayStage(ctx, "quota", job.Subscription.Source.Event)
		release, err := w.Budget.Acquire(quotaCtx, *job)
		if err != nil || release == nil {
			quotaEnd("deferred")
			outcome = "deferred"
			if err == nil {
				err = ErrUnavailable
			}
			return true, err
		}
		quotaEnd("reserved")
		defer release()
	}
	renewCtx, renewEnd := gatewayStage(ctx, "renewal", job.Subscription.Source.Event)
	for i := range jobs {
		renewed, err := w.Queue.Renew(renewCtx, jobFence(jobs[i]), lease)
		if err != nil {
			renewEnd("error")
			return true, err
		}
		jobs[i] = renewed
		if time.Until(renewed.LeaseUntil) < httpTimeout+finishTimeout {
			renewEnd("deferred")
			outcome = "deferred"
			return true, nil
		}
	}
	renewEnd("renewed")
	// Renew changes the CAS version, not the claim generation used by evidence.
	beginCtx, beginEnd := gatewayStage(ctx, "begin_dispatch", job.Subscription.Source.Event)
	started, err := queue.BeginDispatchBatch(beginCtx, BatchFences(jobs), authorizations)
	if err != nil {
		beginEnd("deferred")
		outcome = "deferred"
		return true, err
	}
	if len(started) != len(jobs) || ValidateBatchMembers(started) != nil {
		beginEnd("error")
		return true, ErrConflict
	}
	beginEnd("dispatching")
	jobs, job = started, &started[0]
	// A delayed BeginDispatch must not let HTTP outlive its durable dispatch lease.
	if time.Until(job.LeaseUntil) < httpTimeout+finishTimeout {
		outcome = "ambiguous"
		return true, w.finishBatch(ctx, queue, jobs, Outcome{State: Ambiguous, Reason: "lease_insufficient"})
	}
	dispatchCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	if RequiresLabelRemoval(job.Subscription) {
		if err := w.LabelConsumer.ConsumeLabels(dispatchCtx, jobs); err != nil {
			cancel()
			outcome = "ambiguous"
			return true, errors.Join(err, w.finishBatch(ctx, queue, jobs, Outcome{State: Ambiguous, Reason: "label_consumption_unconfirmed"}))
		}
	}
	dispatchCtx, dispatchEnd := gatewayStage(dispatchCtx, "dispatch", job.Subscription.Source.Event)
	response := dispatch(dispatchCtx, job.Subscription, payload)
	response.Kind = job.Subscription.Destination.Kind
	cancel()
	result, err := ClassifyDispatchResponse(time.Now(), response)
	if err != nil {
		result = DispatchResult{Outcome: "ambiguous", Reason: "invalid-dispatch-observation"}
	}
	final := Outcome{
		State: JobState(result.Outcome), Reason: result.Reason, NotBefore: result.RetryAt,
		AcceptedStatus: result.AcceptedStatus, WorkflowRunID: result.WorkflowRunID,
	}
	if result.Outcome == "retry" {
		final.State = Ready
	}
	traceGatewayAcceptance(dispatchCtx, final.AcceptedStatus, final.WorkflowRunID)
	dispatchEnd(string(final.State))
	outcome = string(final.State)
	return true, w.finishBatch(ctx, queue, jobs, final)
}

func (w *Worker) finishBatch(ctx context.Context, queue BatchQueue, jobs []Job, outcome Outcome) error {
	_, _, finish, _ := w.durations()
	// Shutdown must still persist the knowledge acquired by the external attempt.
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finish)
	defer cancel()
	finishCtx, end := gatewayStage(finishCtx, "finish", jobs[0].Subscription.Source.Event)
	finished, err := queue.FinishBatch(finishCtx, BatchFences(jobs), outcome)
	if err == nil && len(finished) != len(jobs) {
		err = ErrConflict
	}
	if err != nil {
		end("error")
	} else {
		end(string(finished[0].State))
		if finished[0].State == Ready {
			observeGatewayRetry(finishCtx)
		}
	}
	return err
}

func (w *Worker) cancelBatch(ctx context.Context, jobs []Job) error {
	var result error
	for _, job := range jobs {
		_, err := w.Queue.Cancel(ctx, job.ID, job.Version)
		result = errors.Join(result, err)
	}
	return result
}

func (w *Worker) authorizeBatch(ctx context.Context, jobs []Job) ([]AuthorizationSnapshot, error) {
	if authorizer, ok := w.Authorizer.(BatchAuthorizer); ok {
		evidence, err := authorizer.AuthorizeBatch(ctx, jobs)
		if err != nil || len(evidence) != len(jobs) {
			return nil, errors.Join(err, ErrUnauthorized)
		}
		return evidence, nil
	}
	evidence := make([]AuthorizationSnapshot, len(jobs))
	for i, job := range jobs {
		snapshot, err := w.Authorizer.Authorize(ctx, job)
		if err != nil || !snapshot.Complete {
			return nil, errors.Join(err, ErrUnauthorized)
		}
		evidence[i] = snapshot
	}
	return evidence, nil
}
