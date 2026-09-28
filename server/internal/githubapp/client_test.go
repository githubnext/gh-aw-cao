package githubapp

import (
	"errors"
	"net/http"
	"strings"
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
	if response.RetryAfter != delay || response.StatusCode != http.StatusForbidden || !response.Secondary {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestAPIResponseClassifiesSecondaryLimitWithoutRetryAfter(t *testing.T) {
	err := &github.AbuseRateLimitError{
		Response: &http.Response{StatusCode: http.StatusForbidden},
	}
	if response := apiResponse(nil, err); !response.Secondary {
		t.Fatalf("secondary limit was not classified: %#v", response)
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

func TestValidateRepositoryVisibility(t *testing.T) {
	tests := []struct {
		name         string
		control      string
		repositories []Repository
		wantError    string
	}{
		{
			name:    "private control may access private repositories",
			control: "octo/control",
			repositories: []Repository{
				{FullName: "octo/control", Private: true},
				{FullName: "octo/private", Private: true},
			},
		},
		{
			name:    "public control may access public repositories",
			control: "octo/control",
			repositories: []Repository{
				{FullName: "octo/control"},
				{FullName: "octo/public"},
			},
		},
		{
			name:    "public control rejects private repositories",
			control: "octo/control",
			repositories: []Repository{
				{FullName: "octo/control"},
				{FullName: "secret/private", Private: true},
			},
			wantError: "public control repository cannot access non-public repositories",
		},
		{
			name:    "public control rejects internal repositories",
			control: "octo/control",
			repositories: []Repository{
				{FullName: "octo/control", Visibility: "public"},
				{FullName: "secret/internal", Visibility: "internal"},
			},
			wantError: "public control repository cannot access non-public repositories",
		},
		{
			name:         "missing control repository fails closed",
			control:      "octo/control",
			repositories: []Repository{{FullName: "octo/public"}},
			wantError:    "control repository visibility could not be verified",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRepositoryVisibility(tt.control, tt.repositories)
			if tt.wantError == "" {
				if err != nil {
					t.Fatalf("ValidateRepositoryVisibility() error = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("ValidateRepositoryVisibility() error = %v, want %q", err, tt.wantError)
			}
			if strings.Contains(err.Error(), "secret/private") {
				t.Fatalf("error disclosed a private repository name: %v", err)
			}
		})
	}
}
