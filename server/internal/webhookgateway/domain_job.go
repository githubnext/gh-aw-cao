package webhookgateway

import (
	"encoding/json"
	"math"
	"time"
)

// IsTerminal reports irreversible job states.
func IsTerminal(state JobState) bool {
	switch state {
	case Succeeded, Expired, Rejected, Cancelled, Failed, Ambiguous:
		return true
	default:
		return false
	}
}

// NewJob freezes caller-owned subscription/payload memory and uses an explicit supplied identity.
func NewJob(now time.Time, id string, event Event, s Subscription, digest string) (Job, error) {
	if now.IsZero() || !identifier(id) || !digestOK(digest) {
		return Job{}, ErrInvalid
	}
	matched, err := MatchSubscription(s, event, DefaultLimits())
	if err != nil {
		return Job{}, err
	}
	if !matched {
		return Job{}, ErrInvalid
	}
	payload, err := BuildDispatchPayload(s, event, DefaultLimits())
	if err != nil {
		return Job{}, err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return Job{}, ErrInvalid
	}
	var frozen Subscription
	if err := json.Unmarshal(data, &frozen); err != nil {
		return Job{}, ErrInvalid
	}
	return Job{ID: id, DeliveryID: event.DeliveryID, Subscription: frozen,
		SubscriptionDigest: digest, Event: IdentityOf(event), Payload: payload,
		State: Ready, Version: 1, CreatedAt: now, NotBefore: now,
		ExpiresAt: now.Add(durationSeconds(s.Delivery.TTLSeconds))}, nil
}

func mutable(now time.Time, j Job) error {
	if now.IsZero() || now.Before(j.CreatedAt) || IsTerminal(j.State) || j.Version == math.MaxUint64 {
		return ErrConflict
	}
	return nil
}

// ClaimJob requires a strictly newer external fence and an exact expected version.
func ClaimJob(now time.Time, j Job, expectedVersion, fence uint64, claimID string) (Job, error) {
	if err := mutable(now, j); err != nil {
		return Job{}, err
	}
	if j.State != Ready || expectedVersion != j.Version || fence <= j.Fence ||
		!identifier(claimID) || !j.ExpiresAt.After(now) || j.NotBefore.After(now) ||
		j.Attempt >= j.Subscription.Delivery.MaxAttempts {
		return Job{}, ErrConflict
	}
	j.State, j.ClaimID, j.Fence = Claimed, claimID, fence
	j.LeaseUntil = now.Add(durationSeconds(j.Subscription.Delivery.LeaseSeconds))
	if j.LeaseUntil.After(j.ExpiresAt) {
		j.LeaseUntil = j.ExpiresAt
	}
	j.Version++
	return j, nil
}

func owns(now time.Time, j Job, fence uint64, claimID string) bool {
	return j.Fence == fence && j.ClaimID == claimID && claimID != "" && j.LeaseUntil.After(now)
}

func acceptedObservation(kind string, status int, runID int64) bool {
	if kind != "workflow_dispatch" && kind != "repository_dispatch" {
		return false
	}
	return status == 204 && runID == 0 || kind == "workflow_dispatch" && status == 200 && runID > 0
}

// RetryDelay computes saturating exponential backoff with explicit bounded jitter.
// Attempt one uses base; attempt zero is treated as one. Nonpositive base disables
// the delay. Jitter is clamped to [0, exponential/4], and the total never exceeds one hour.
func RetryDelay(base time.Duration, attempt uint32, jitter time.Duration) time.Duration {
	const maximum = time.Hour
	if base <= 0 {
		return 0
	}
	delay := min(base, maximum)
	for attempt > 1 && delay < maximum {
		if delay >= maximum/2 {
			delay = maximum
		} else {
			delay *= 2
		}
		attempt--
	}
	jitter = max(time.Duration(0), min(jitter, delay/4))
	return min(maximum, delay+jitter)
}

// StartDispatch records uncertainty durably before external I/O, consuming one attempt.
func StartDispatch(now time.Time, j Job, fence uint64, claimID string, decision AuthorizationDecision) (Job, error) {
	if err := mutable(now, j); err != nil {
		return Job{}, err
	}
	if j.State != Claimed || !owns(now, j, fence, claimID) || !j.ExpiresAt.After(now) ||
		j.Attempt >= j.Subscription.Delivery.MaxAttempts || !decision.Allowed || decision.Cancel {
		return Job{}, ErrUnauthorized
	}
	j.State, j.Reason = Dispatching, ""
	j.Attempt++
	j.Version++
	return j, nil
}

// FinishDispatch retries only classifier-proven nonacceptance while preserving TTL and attempts.
func FinishDispatch(now time.Time, j Job, fence uint64, claimID string, result DispatchResult) (Job, error) {
	if err := mutable(now, j); err != nil {
		return Job{}, err
	}
	if j.State != Dispatching || !owns(now, j, fence, claimID) {
		return Job{}, ErrConflict
	}
	if result.Outcome == "succeeded" {
		if !acceptedObservation(j.Subscription.Destination.Kind, result.AcceptedStatus, result.WorkflowRunID) {
			return Job{}, ErrInvalid
		}
	} else if result.AcceptedStatus != 0 || result.WorkflowRunID != 0 {
		return Job{}, ErrInvalid
	}
	j.AcceptedStatus, j.WorkflowRunID = 0, 0
	switch result.Outcome {
	case "succeeded":
		j.State = Succeeded
		j.AcceptedStatus, j.WorkflowRunID = result.AcceptedStatus, result.WorkflowRunID
	case "rejected":
		j.State = Rejected
	case "failed":
		j.State = Failed
	case "ambiguous":
		j.State = Ambiguous
	case "retry":
		if result.Reason != "rate-limited" && result.Reason != "not-sent" {
			return Job{}, ErrInvalid
		}
		j.State = Ready
		j.NotBefore = now.Add(RetryDelay(durationSeconds(j.Subscription.Delivery.RetryDelaySeconds), j.Attempt, result.RetryJitter))
		if result.RetryAt.After(j.NotBefore) {
			j.NotBefore = result.RetryAt
		}
		if !j.ExpiresAt.After(j.NotBefore) {
			j.State = Expired
		} else if j.Attempt >= j.Subscription.Delivery.MaxAttempts {
			j.State = Failed
		}
	default:
		return Job{}, ErrInvalid
	}
	j.Reason = result.Reason
	j.ClaimID, j.LeaseUntil = "", time.Time{}
	j.Version++
	return j, nil
}

// RecoverJob never replays an uncertain dispatch, even when its job TTL has expired.
func RecoverJob(now time.Time, j Job) (Job, error) {
	if err := mutable(now, j); err != nil {
		return Job{}, err
	}
	switch {
	case j.State == Dispatching && (!j.LeaseUntil.After(now) || !j.ExpiresAt.After(now)):
		j.State, j.Reason = Ambiguous, "dispatch-completion-unknown"
	case !j.ExpiresAt.After(now):
		j.State, j.Reason = Expired, "ttl-expired"
	case j.State == Claimed && !j.LeaseUntil.After(now):
		j.State, j.Reason = Ready, "claim-recovered"
	case j.State == Ready && j.Attempt >= j.Subscription.Delivery.MaxAttempts:
		j.State, j.Reason = Failed, "attempts-exhausted"
	default:
		return j, nil
	}
	if j.Fence == math.MaxUint64 {
		return Job{}, ErrConflict
	}
	j.Fence++
	j.Version++
	j.ClaimID, j.LeaseUntil = "", time.Time{}
	return j, nil
}

// CancelJob cancels only work known not to have entered external dispatch.
func CancelJob(now time.Time, j Job, expectedVersion uint64) (Job, error) {
	if err := mutable(now, j); err != nil {
		return Job{}, err
	}
	if expectedVersion != j.Version || (j.State != Ready && j.State != Claimed) || j.Fence == math.MaxUint64 {
		return Job{}, ErrConflict
	}
	j.State, j.Reason = Cancelled, "cancelled"
	j.Version++
	j.Fence++
	j.ClaimID, j.LeaseUntil = "", time.Time{}
	return j, nil
}

// ValidateJob checks the immutable bounded job contract before persistence.
func ValidateJob(j Job) error {
	if !identifier(j.ID) || !identifier(j.DeliveryID) || !digestOK(j.SubscriptionDigest) ||
		!validTraceParent(j.TraceParent) ||
		j.CreatedAt.IsZero() || !j.ExpiresAt.After(j.CreatedAt) || j.Version == 0 ||
		j.ExpiresAt.Sub(j.CreatedAt) > durationSeconds(j.Subscription.Delivery.TTLSeconds) ||
		j.Attempt > j.Subscription.Delivery.MaxAttempts {
		return ErrInvalid
	}
	if j.State != Ready && j.State != Claimed && j.State != Dispatching && !IsTerminal(j.State) {
		return ErrInvalid
	}
	if j.State == Succeeded {
		if !acceptedObservation(j.Subscription.Destination.Kind, j.AcceptedStatus, j.WorkflowRunID) {
			return ErrInvalid
		}
	} else if j.AcceptedStatus != 0 || j.WorkflowRunID != 0 {
		return ErrInvalid
	}
	if err := ValidateSubscription(j.Subscription, DefaultLimits()); err != nil {
		return err
	}
	if !validEventIdentity(j.Event, j.Subscription) || j.Event.DeliveryID != j.DeliveryID {
		return ErrInvalid
	}
	return validateCompiledPayload(j)
}

// ValidateQueueOptions rejects partial, contradictory, or effectively unbounded queue settings.
func ValidateQueueOptions(o QueueOptions) error {
	for _, n := range []int64{o.MaxRows, o.MaxBytes, o.MaxTenantRows, o.MaxTenantBytes,
		o.MaxSourceRows, o.MaxSourceBytes, o.MaxDestinationRows, o.MaxDestinationBytes, o.MaxPayloadBytes} {
		if n < 1 {
			return ErrInvalid
		}
	}
	if o.MaxBatch < 1 || o.MaxBatch > 1024 || o.MaxConcurrency < 1 ||
		o.MaxAge < time.Second || o.MaxAge > 7*24*time.Hour ||
		o.DedupWindow < o.MaxAge || o.TerminalRetention < o.DedupWindow ||
		o.LeaseDuration < time.Second || o.LeaseDuration > o.MaxAge ||
		o.MaxPayloadBytes > int64(DefaultLimits().MaxEventBytes) ||
		o.MaxTenantRows > o.MaxRows || o.MaxSourceRows > o.MaxRows ||
		o.MaxDestinationRows > o.MaxRows || o.MaxTenantBytes > o.MaxBytes ||
		o.MaxSourceBytes > o.MaxBytes || o.MaxDestinationBytes > o.MaxBytes {
		return ErrInvalid
	}
	for _, r := range []RateBudget{o.Rates.Global, o.Rates.App, o.Rates.Tenant, o.Rates.Destination, o.Rates.Workflow} {
		if r.Capacity < 1 || r.Period < time.Second || r.Period > 24*time.Hour {
			return ErrInvalid
		}
	}
	return nil
}

// ValidateAdmission checks an entire delivery before any deduplication or capacity mutation.
func ValidateAdmission(a Admission, o QueueOptions) error {
	if err := ValidateQueueOptions(o); err != nil {
		return err
	}
	if !identifier(a.DeliveryID) || !digestOK(a.DeliveryDigest) ||
		a.Revision.Revision < 1 || !digestOK(a.Revision.Digest) || !a.Revision.Enabled ||
		len(a.Jobs) > o.MaxBatch {
		return ErrInvalid
	}
	seen := map[string]bool{}
	ids := map[string]bool{}
	for _, j := range a.Jobs {
		if err := ValidateJob(j); err != nil {
			return err
		}
		if j.DeliveryID != a.DeliveryID || j.State != Ready || j.Attempt != 0 ||
			j.Fence != 0 || j.ClaimID != "" || j.Version != 1 ||
			len(j.Payload) > int(o.MaxPayloadBytes) ||
			j.ExpiresAt.Sub(j.CreatedAt) > o.MaxAge ||
			(j.QueueRevision != (QueueRevision{}) && j.QueueRevision != a.Revision) ||
			seen[j.Subscription.ID] || ids[j.ID] {
			return ErrInvalid
		}
		seen[j.Subscription.ID], ids[j.ID] = true, true
	}
	return nil
}
