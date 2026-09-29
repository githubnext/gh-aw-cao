package githubapp

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bradleyfalzon/ghinstallation/v2"
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

func TestAPIResponseReadsRateLimitedInstallationTokenMint(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "30")
	header.Set("X-RateLimit-Remaining", "4000")
	err := fmt.Errorf("read repository ref: %w", &ghinstallation.HTTPError{
		Message:  "received non 2xx response status",
		Response: &http.Response{StatusCode: http.StatusForbidden, Header: header},
	})

	response := apiResponse(nil, err)
	if response.StatusCode != http.StatusForbidden || response.RetryAfter != 30*time.Second ||
		!response.Secondary || response.Remaining != 4000 {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestAPIResponseReadsPrimaryLimitedInstallationTokenMint(t *testing.T) {
	reset := time.Now().Add(time.Minute).Unix()
	header := http.Header{}
	header.Set("X-RateLimit-Remaining", "0")
	header.Set("X-RateLimit-Reset", strconv.FormatInt(reset, 10))
	err := &ghinstallation.HTTPError{
		Response: &http.Response{StatusCode: http.StatusForbidden, Header: header},
	}

	response := apiResponse(nil, err)
	if response.Remaining != 0 || response.Reset.Unix() != reset || response.Secondary {
		t.Fatalf("unexpected response: %#v", response)
	}
}
