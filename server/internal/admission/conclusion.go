package admission

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/githubnext/gh-cao/server/internal/telemetry"
)

// Completion needs current enrollment, not another budget entitlement.
type ConclusionPolicySource interface {
	AuthorizeConclusion(context.Context, Identity) error
}

// RecordConclusion atomically retains the first immutable, invocation-bound
// payload before publication. Pending retries repair publication; completed
// receipts prevent repeated downstream processing.
type ConclusionSessions interface {
	RecordConclusion(context.Context, Identity, ConclusionRequest) (ConclusionReceipt, error)
	CompleteConclusion(context.Context, Identity) error
}

type ConclusionReceipt struct {
	AcceptedAt time.Time `json:"accepted_at"`
	Populated  bool      `json:"populated"`
}

type ConcludedRuns interface {
	RecordConcludedRun(context.Context, Identity, ConclusionRequest, time.Time) error
}

func (s *Service) Conclude(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusForbidden
	defer func() { w.WriteHeader(status) }()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	identity, data, failure := s.authenticatedRequest(w, r.WithContext(ctx), MaxConclusionBytes)
	if failure != 0 {
		status = failure
		return
	}
	input, err := decodeConclusion(data)
	if err != nil || !input.matches(identity) {
		return
	}
	if s.ConclusionPolicies == nil || s.Conclusions == nil || s.ConclusionRuns == nil {
		status = http.StatusServiceUnavailable
		return
	}
	_, err = observeOperation(ctx, telemetry.SpanConclusionPolicy, func(ctx context.Context) (struct{}, error) {
		return struct{}{}, s.ConclusionPolicies.AuthorizeConclusion(ctx, identity)
	})
	if err == nil {
		var receipt ConclusionReceipt
		receipt, err = observeOperation(ctx, telemetry.SpanConclusionRecord, func(ctx context.Context) (ConclusionReceipt, error) {
			return s.Conclusions.RecordConclusion(ctx, identity, input)
		})
		if err == nil && !receipt.Populated {
			_, err = observeOperation(ctx, telemetry.SpanConclusionPublish, func(ctx context.Context) (struct{}, error) {
				return struct{}{}, s.publishConclusion(ctx, identity, input, receipt)
			})
		}
	}
	if err != nil {
		status = conclusionFailureStatus(err)
		admissionLog.Printf("conclusion rejected: status=%d denied=%t", status, errors.Is(err, ErrDenied))
		return
	}
	if ctx.Err() != nil {
		status = http.StatusServiceUnavailable
		return
	}
	status = http.StatusNoContent
	admissionLog.Printf("conclusion accepted")
}

// conclusionFailureStatus maps a failed conclusion step to an HTTP status:
// denials stay opaque as 403 while every other failure is retryable as 503.
func conclusionFailureStatus(err error) int {
	if errors.Is(err, ErrDenied) {
		return http.StatusForbidden
	}
	return http.StatusServiceUnavailable
}

// publishConclusion publishes a retained, unpopulated conclusion and then
// marks it complete so retries stop repeating downstream processing.
func (s *Service) publishConclusion(ctx context.Context, identity Identity, input ConclusionRequest, receipt ConclusionReceipt) error {
	if receipt.AcceptedAt.IsZero() {
		return ErrUnavailable
	}
	if err := s.ConclusionRuns.RecordConcludedRun(ctx, identity, input, receipt.AcceptedAt); err != nil {
		return err
	}
	return s.Conclusions.CompleteConclusion(ctx, identity)
}
