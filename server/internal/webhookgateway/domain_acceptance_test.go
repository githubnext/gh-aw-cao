package webhookgateway

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDomainSuccessRequiresAcceptedObservation(t *testing.T) {
	_, _, job, _ := domainFixture(t)
	now := job.CreatedAt
	claimed, err := ClaimJob(now, job, job.Version, 1, "worker")
	if err != nil {
		t.Fatal(err)
	}
	dispatching, err := StartDispatch(now, claimed, 1, "worker", AuthorizationDecision{Allowed: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range []DispatchResult{
		{Outcome: "succeeded"},
		{Outcome: "succeeded", AcceptedStatus: 404},
		{Outcome: "succeeded", AcceptedStatus: 200},
		{Outcome: "succeeded", AcceptedStatus: 200, WorkflowRunID: -1},
		{Outcome: "succeeded", AcceptedStatus: 204, WorkflowRunID: 123},
		{Outcome: "ambiguous", AcceptedStatus: 200, WorkflowRunID: 123},
		{Outcome: "retry", Reason: "rate-limited", AcceptedStatus: 204},
	} {
		if _, err := FinishDispatch(now, dispatching, 1, "worker", result); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid acceptance evidence allowed: %+v %v", result, err)
		}
	}
	for _, result := range []DispatchResult{
		{Outcome: "succeeded", AcceptedStatus: 204},
		{Outcome: "succeeded", AcceptedStatus: 200, WorkflowRunID: 123},
	} {
		completed, err := FinishDispatch(now, dispatching, 1, "worker", result)
		if err != nil || completed.State != Succeeded || completed.AcceptedStatus != result.AcceptedStatus ||
			completed.WorkflowRunID != result.WorkflowRunID {
			t.Fatalf("acceptance not retained: %+v %v", completed, err)
		}
		if err := ValidateJob(completed); err != nil {
			t.Fatalf("valid acceptance job rejected: %v", err)
		}
	}
	dispatching.Subscription.Destination.Kind = "repository_dispatch"
	if _, err := FinishDispatch(now, dispatching, 1, "worker",
		DispatchResult{Outcome: "succeeded", AcceptedStatus: 200, WorkflowRunID: 123}); !errors.Is(err, ErrInvalid) {
		t.Fatal("workflow acceptance applied to repository dispatch")
	}
}

func TestDomainAcceptanceClassifierRetainsOnlySafeScalars(t *testing.T) {
	_, _, job, _ := domainFixture(t)
	for _, body := range []string{
		`{}`, `{"workflow_run_id":0}`, `{"workflow_run_id":-1}`, `{"workflow_run_id":"123"}`,
		`{"workflow_run_id":9223372036854775808}`, `{"workflow_run_id":123,`,
		`{"workflow_run_id":123,"workflow_run_id":456}`,
	} {
		result, err := ClassifyDispatchResponse(job.CreatedAt, DispatchResponse{
			Kind: "workflow_dispatch", StatusCode: 200, TransportOutcome: "response", Body: json.RawMessage(body),
		})
		if err != nil || result.Outcome != "ambiguous" || result.AcceptedStatus != 0 || result.WorkflowRunID != 0 {
			t.Fatalf("unverified run detail retained: %s %+v %v", body, result, err)
		}
	}
	for _, status := range []int{403, 404, 429, 500} {
		result, err := ClassifyDispatchResponse(job.CreatedAt, DispatchResponse{
			Kind: "workflow_dispatch", StatusCode: status, TransportOutcome: "response", WorkflowRunID: 123,
		})
		if err != nil || result.AcceptedStatus != 0 || result.WorkflowRunID != 0 {
			t.Fatalf("nonacceptance retained run detail: %+v %v", result, err)
		}
	}
	result, err := ClassifyDispatchResponse(job.CreatedAt, DispatchResponse{
		Kind: "workflow_dispatch", StatusCode: 200, TransportOutcome: "response", WorkflowRunID: 123,
	})
	if err != nil || result.Outcome != "succeeded" || result.AcceptedStatus != 200 || result.WorkflowRunID != 123 {
		t.Fatalf("bounded adapter run identity lost: %+v %v", result, err)
	}
}
