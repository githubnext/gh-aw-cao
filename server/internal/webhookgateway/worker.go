package webhookgateway

import (
	"context"
	"errors"
	"time"

	servertelemetry "github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

// Worker owns one fenced claim at a time. External HTTP is never performed by Queue.
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

// RunOnce returns whether it claimed a job, not whether GitHub accepted it.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	if w.Policies == nil || w.Queue == nil || w.Authorizer == nil || w.Dispatcher == nil || w.Owner == "" {
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
	job, err := w.Queue.Claim(claimCtx, ClaimRequest{Owner: w.Owner, LeaseDuration: lease})
	if errors.Is(err, ErrNotFound) || (err == nil && job == nil) {
		claimEnd("empty")
		outcome = "empty"
		return false, nil
	}
	if err != nil {
		claimEnd("error")
		return false, err
	}
	claimEnd("claimed")
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
	revision, exists := snapshot.Revisions[job.Subscription.ID]
	if !snapshot.Revision.Enabled || !exists || revision.Digest != job.SubscriptionDigest {
		_, err = w.Queue.Cancel(ctx, job.ID, job.Version)
		outcome = "cancelled"
		return true, err
	}
	authCtx, authEnd := gatewayStage(ctx, "authorization", job.Subscription.Source.Event)
	authorization, err := w.Authorizer.Authorize(authCtx, *job)
	if err != nil || !authorization.Complete {
		authEnd("deferred")
		outcome = "deferred"
		// Unknown authority stays claimed until safe claim recovery or TTL expiry.
		return true, err
	}
	decision, err := ValidateAuthorization(time.Now(), *job, authorization)
	if err != nil {
		authEnd("error")
		return true, err
	}
	if decision.Cancel {
		authEnd("auth_denied")
		_, err = w.Queue.Cancel(ctx, job.ID, job.Version)
		outcome = "cancelled"
		return true, err
	}
	if !decision.Allowed {
		authEnd("deferred")
		outcome = "deferred"
		return true, nil
	}
	authEnd("authorized")
	if err := ValidateJob(*job); err != nil {
		_, cancelErr := w.Queue.Cancel(ctx, job.ID, job.Version)
		return true, cancelErr
	}
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
	renewed, err := w.Queue.Renew(renewCtx, jobFence(*job), lease)
	if err != nil {
		renewEnd("error")
		return true, err
	}
	renewEnd("renewed")
	job = &renewed
	if time.Until(job.LeaseUntil) < httpTimeout+finishTimeout {
		outcome = "deferred"
		return true, nil
	}
	// Renew changes the CAS version, not the claim generation used by evidence.
	beginCtx, beginEnd := gatewayStage(ctx, "begin_dispatch", job.Subscription.Source.Event)
	started, err := w.Queue.BeginDispatch(beginCtx, jobFence(*job), Authorization{
		Revision: snapshot.Revision, ApprovedSubscriptionDigest: revision.Digest, Snapshot: authorization,
	})
	if err != nil {
		beginEnd("deferred")
		outcome = "deferred"
		return true, err
	}
	beginEnd("dispatching")
	job = &started
	// A delayed BeginDispatch must not let HTTP outlive its durable dispatch lease.
	if time.Until(job.LeaseUntil) < httpTimeout+finishTimeout {
		outcome = "ambiguous"
		return true, w.finish(ctx, *job, Outcome{State: Ambiguous, Reason: "lease_insufficient"})
	}
	dispatchCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	dispatchCtx, dispatchEnd := gatewayStage(dispatchCtx, "dispatch", job.Subscription.Source.Event)
	response := w.Dispatcher.Dispatch(dispatchCtx, job.Subscription, job.Payload)
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
	return true, w.finish(ctx, *job, final)
}

func (w *Worker) finish(ctx context.Context, job Job, outcome Outcome) error {
	_, _, finish, _ := w.durations()
	// Shutdown must still persist the knowledge acquired by the external attempt.
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finish)
	defer cancel()
	finishCtx, end := gatewayStage(finishCtx, "finish", job.Subscription.Source.Event)
	finished, err := w.Queue.Finish(finishCtx, jobFence(job), outcome)
	if err != nil {
		end("error")
	} else {
		end(string(finished.State))
		if finished.State == Ready {
			observeGatewayRetry(finishCtx)
		}
	}
	return err
}
