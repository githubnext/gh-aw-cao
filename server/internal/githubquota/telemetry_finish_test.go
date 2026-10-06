package githubquota

import (
	"context"
	"errors"
	"testing"

	"go.opentelemetry.io/otel/codes"
)

func TestClassifyOperationFinishUnavailableBucket(t *testing.T) {
	err := &UnavailableError{Bucket: BucketID{App: "collector"}, Status: StatusExhausted}
	classification := classifyOperationFinish(outcomeSuccess, err)
	if classification.outcome != string(StatusExhausted) {
		t.Fatalf("outcome = %q, want %q", classification.outcome, StatusExhausted)
	}
	if classification.statusCode != codes.Ok {
		t.Fatalf("statusCode = %v, want Ok", classification.statusCode)
	}
	if classification.statusAttr != string(StatusExhausted) {
		t.Fatalf("statusAttr = %q, want %q", classification.statusAttr, StatusExhausted)
	}
	if classification.errorType != "" {
		t.Fatalf("errorType = %q, want empty for an expected admission outcome", classification.errorType)
	}
}

func TestClassifyOperationFinishNoCandidates(t *testing.T) {
	classification := classifyOperationFinish(outcomeSuccess, ErrNoCandidates)
	if classification.outcome != outcomeNoBucket {
		t.Fatalf("outcome = %q, want %q", classification.outcome, outcomeNoBucket)
	}
	if classification.statusCode != codes.Ok {
		t.Fatalf("statusCode = %v, want Ok", classification.statusCode)
	}
	if classification.statusAttr != "" || classification.errorType != "" {
		t.Fatalf("empty candidates must not attach status or error.type attributes: %+v", classification)
	}
}

func TestClassifyOperationFinishInvalidRequest(t *testing.T) {
	classification := classifyOperationFinish(outcomeInvalid, errors.New("bad bucket"))
	if classification.outcome != outcomeInvalid {
		t.Fatalf("outcome = %q, want %q", classification.outcome, outcomeInvalid)
	}
	if classification.statusCode != codes.Error {
		t.Fatalf("statusCode = %v, want Error", classification.statusCode)
	}
	if classification.errorType != "invalid_request" {
		t.Fatalf("errorType = %q, want invalid_request", classification.errorType)
	}
	if classification.statusDescription == "" {
		t.Fatal("invalid request must record a status description")
	}
}

func TestClassifyOperationFinishUnexpectedError(t *testing.T) {
	classification := classifyOperationFinish(outcomeSuccess, context.DeadlineExceeded)
	if classification.outcome != outcomeError {
		t.Fatalf("outcome = %q, want %q", classification.outcome, outcomeError)
	}
	if classification.statusCode != codes.Error {
		t.Fatalf("statusCode = %v, want Error", classification.statusCode)
	}
	if classification.errorType != "timeout" {
		t.Fatalf("errorType = %q, want timeout", classification.errorType)
	}
}

func TestClassifyOperationFinishSuccess(t *testing.T) {
	classification := classifyOperationFinish(outcomeAdmitted, nil)
	if classification.outcome != outcomeAdmitted {
		t.Fatalf("outcome = %q, want %q", classification.outcome, outcomeAdmitted)
	}
	if classification.statusCode != codes.Ok {
		t.Fatalf("statusCode = %v, want Ok", classification.statusCode)
	}
	if classification.statusAttr != "" || classification.errorType != "" {
		t.Fatalf("success must not attach status or error.type attributes: %+v", classification)
	}
}
