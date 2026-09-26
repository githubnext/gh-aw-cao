package githubapp

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/go-github/v66/github"
)

func TestAPIResponseReadsPrimaryRateLimit(t *testing.T) {
	reset := time.Now().Add(time.Minute).UTC()
	err := &github.RateLimitError{
		Rate:     github.Rate{Remaining: 0, Reset: github.Timestamp{Time: reset}},
		Response: &http.Response{StatusCode: http.StatusForbidden},
	}

	response := apiResponse(nil, err)
	if response.Remaining != 0 || !response.Reset.Equal(reset) ||
		response.StatusCode != http.StatusForbidden {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestAPIResponseReadsSecondaryRetryAfter(t *testing.T) {
	delay := 12 * time.Second
	err := &github.AbuseRateLimitError{
		RetryAfter: &delay,
		Response:   &http.Response{StatusCode: http.StatusForbidden},
	}

	response := apiResponse(nil, err)
	if response.RetryAfter != delay || response.StatusCode != http.StatusForbidden {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestClassifyGitHubNotFound(t *testing.T) {
	err := classifyGitHubError(
		"resolve repository ref",
		errors.New("request failed"),
		APIResponse{StatusCode: http.StatusNotFound},
	)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found classification: %v", err)
	}
}
