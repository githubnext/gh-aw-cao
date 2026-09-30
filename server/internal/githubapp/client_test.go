package githubapp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bradleyfalzon/ghinstallation/v2"
	"github.com/google/go-github/v66/github"
)

func TestListWorkflowRunsExposesPaginatedRunIdentity(t *testing.T) {
	var requestedPages []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestedPages = append(requestedPages, request.URL.Query().Get("page"))
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-RateLimit-Limit", "5000")
		response.Header().Set("X-RateLimit-Remaining", "4999")
		response.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
		response.Header().Set("X-RateLimit-Resource", "core")
		if request.URL.Query().Get("page") == "1" {
			response.Header().Set("Link", fmt.Sprintf(
				"<%s/repos/octo/api/actions/runs?page=2&per_page=1>; rel=\"next\"", serverURL(request),
			))
			_, _ = response.Write([]byte(`{"total_count":2,"workflow_runs":[{"id":42,"run_attempt":2,"created_at":"2026-01-02T03:04:05Z"}]}`))
			return
		}
		_, _ = response.Write([]byte(`{"total_count":2,"workflow_runs":[{"id":43,"run_attempt":1,"created_at":"2026-01-01T03:04:05Z"}]}`))
	}))
	defer server.Close()

	baseURL, err := url.Parse(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	installationClient := github.NewClient(server.Client())
	installationClient.BaseURL = baseURL
	client := &Client{
		installations: map[int64]*installationEntry{
			7: {client: installationClient},
		},
	}
	first, nextPage, quota, err := client.ListWorkflowRuns(context.Background(), 7, "octo/api", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || first[0].ID != 42 || first[0].Attempt != 2 ||
		!first[0].CreatedAt.Equal(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)) || nextPage != 2 {
		t.Fatalf("first page runs=%+v next=%d, want run 42 attempt 2 next page 2", first, nextPage)
	}
	if !quota.HasResponse || !quota.HasObservation || quota.Resource != "core" || quota.Observation.Remaining != 4999 {
		t.Fatalf("first page quota=%+v, want core response observation", quota)
	}
	second, nextPage, _, err := client.ListWorkflowRuns(context.Background(), 7, "octo/api", nextPage, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].ID != 43 || second[0].Attempt != 1 || nextPage != 0 {
		t.Fatalf("second page runs=%+v next=%d, want run 43 attempt 1 and no next page", second, nextPage)
	}
	if got := strings.Join(requestedPages, ","); got != "1,2" {
		t.Fatalf("requested pages=%q, want 1,2", got)
	}
}

func TestQuotaRateLimitReturnsCoreObservation(t *testing.T) {
	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-RateLimit-Limit", "5000")
		response.Header().Set("X-RateLimit-Remaining", "4321")
		response.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		response.Header().Set("X-RateLimit-Resource", "core")
		_, _ = fmt.Fprintf(response, `{"resources":{"core":{"limit":5000,"remaining":4321,"reset":%d}}}`,
			reset.Unix())
	}))
	defer server.Close()
	baseURL, err := url.Parse(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	installationClient := github.NewClient(server.Client())
	installationClient.BaseURL = baseURL
	client := &Client{
		installations: map[int64]*installationEntry{
			7: {client: installationClient},
		},
	}
	quota, err := client.QuotaRateLimit(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	if !quota.HasResponse || !quota.HasObservation || quota.Resource != "core" ||
		quota.Observation.Limit != 5000 || quota.Observation.Remaining != 4321 ||
		!quota.Observation.ResetAt.Equal(reset) {
		t.Fatalf("quota observation=%+v, want core 4321/5000 reset at %s", quota, reset)
	}
}

func serverURL(request *http.Request) string {
	return "http://" + request.Host
}

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
