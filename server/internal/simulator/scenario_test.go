package simulator

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

func TestGenerateIsDeterministicAndScalesToTwentyThousandRepositories(t *testing.T) {
	scenario := Scenario{
		Name:                "scale",
		Repositories:        20_000,
		EventsPerRepository: 1,
		Seed:                42,
		Distribution:        "uniform",
	}
	first, err := scenario.Generate()
	if err != nil {
		t.Fatal(err)
	}
	second, err := scenario.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 20_201 || len(second) != len(first) {
		t.Fatalf("generated %d and %d deliveries, want 20,201 each", len(first), len(second))
	}
	for i := range first {
		if first[i].ID != second[i].ID || first[i].Event != second[i].Event ||
			string(first[i].Payload) != string(second[i].Payload) {
			t.Fatalf("delivery %d changed between runs", i)
		}
	}
}

func TestGenerateIncludesInstallationChangesAndDistribution(t *testing.T) {
	scenario := Scenario{
		Name:                "changes",
		Repositories:        4,
		EventsPerRepository: 4,
		Seed:                7,
		Distribution:        "synchronized",
		OutOfOrder:          true,
		RemoveRepositories:  true,
	}
	deliveries, err := scenario.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if deliveries[0].Event != "installation" || deliveries[1].Event != "installation_repositories" ||
		deliveries[len(deliveries)-1].Event != "installation_repositories" {
		t.Fatalf("unexpected installation event order: %#v", deliveries)
	}
	var repositorySet map[string]any
	if err := json.Unmarshal(deliveries[len(deliveries)-1].Payload, &repositorySet); err != nil {
		t.Fatal(err)
	}
	if repositorySet["action"] != "removed" {
		t.Fatalf("repository removal event has action %v", repositorySet["action"])
	}
	var firstWorkflowTimestamp string
	lastSequence := -1
	seenOutOfOrder := false
	for _, delivery := range deliveries {
		if delivery.Event != "workflow_run" {
			continue
		}
		var payload struct {
			WorkflowRun struct {
				CreatedAt string `json:"created_at"`
			} `json:"workflow_run"`
		}
		if err := json.Unmarshal(delivery.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if firstWorkflowTimestamp == "" {
			firstWorkflowTimestamp = payload.WorkflowRun.CreatedAt
		} else if firstWorkflowTimestamp != payload.WorkflowRun.CreatedAt {
			t.Fatalf("synchronized event timestamps differ: %s and %s", firstWorkflowTimestamp, payload.WorkflowRun.CreatedAt)
		}
		if delivery.Sequence < lastSequence {
			seenOutOfOrder = true
		}
		lastSequence = delivery.Sequence
	}
	if !seenOutOfOrder {
		t.Fatal("out_of_order scenario did not alter delivery order")
	}
}

func TestLoadScenarioRejectsUnknownFieldsAndOverlappingWindows(t *testing.T) {
	for _, input := range []string{
		`{"name":"x","repositories":1,"unknown":true}`,
		`{"name":"x","repositories":1,"api":[{"from":"0s","to":"2s","mode":"healthy"},{"from":"1s","to":"3s","mode":"healthy"}]}`,
		`{"name":"x","repositories":20001}`,
	} {
		if _, err := LoadScenario([]byte(input)); err == nil {
			t.Fatalf("accepted invalid scenario: %s", input)
		}
	}
}

func TestFiveHourOutageScenarioFixture(t *testing.T) {
	content, err := os.ReadFile("../../testdata/ingestion-scenarios/five-hour-outage.json")
	if err != nil {
		t.Fatal(err)
	}
	scenario, err := LoadScenario(content)
	if err != nil {
		t.Fatal(err)
	}
	if scenario.Repositories != 10000 || scenario.API[0].Mode != "unavailable" ||
		scenario.API[1].Mode != "intermittent" || scenario.ReplayCount != 100 {
		t.Fatalf("unexpected outage scenario: %#v", scenario)
	}
}

func TestDeliverSignsWebhooksAndAppliesDuplicateDropAndReplayRules(t *testing.T) {
	const secret = "simulator-secret"
	var mu sync.Mutex
	deliveries := make(map[string]int)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write(payload)
		if got, want := request.Header.Get("X-Hub-Signature-256"), "sha256="+hex.EncodeToString(mac.Sum(nil)); got != want {
			t.Errorf("signature = %q, want %q", got, want)
		}
		if request.Header.Get("X-GitHub-Delivery") == "" {
			t.Error("delivery ID is missing")
		}
		mu.Lock()
		deliveries[request.Header.Get("X-GitHub-Delivery")]++
		mu.Unlock()
		writer.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	scenario := Scenario{
		Name:                "duplicates",
		Repositories:        4,
		EventsPerRepository: 4,
		Seed:                12,
		Distribution:        "uniform",
		DuplicateEvery:      2,
		DropEvery:           4,
		ReplayCount:         2,
	}
	result, err := scenario.Deliver(context.Background(), server.Client(), server.URL, secret, 4)
	if err != nil {
		t.Fatal(err)
	}
	if result.Dropped != 4 || result.Duplicates != 6 || result.Replayed != 2 ||
		result.Attempts != 1+1+4+12-4+4+2 {
		t.Fatalf("unexpected delivery result: %#v", result)
	}
	duplicateCount := 0
	for _, count := range deliveries {
		if count > 1 {
			duplicateCount++
		}
	}
	if duplicateCount < 2 {
		t.Fatalf("only %d deliveries were repeated", duplicateCount)
	}
}

func TestFakeGitHubAPIModes(t *testing.T) {
	tests := []struct {
		mode string
		want int
	}{
		{mode: "healthy", want: http.StatusOK},
		{mode: "rate-limited", want: http.StatusTooManyRequests},
		{mode: "secondary-rate-limit", want: http.StatusForbidden},
		{mode: "internal-error", want: http.StatusInternalServerError},
		{mode: "bad-gateway", want: http.StatusBadGateway},
		{mode: "service-unavailable", want: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.mode, func(t *testing.T) {
			scenario := Scenario{
				Name:         test.mode,
				Repositories: 1,
				API: []APIWindow{{
					From: "0s", To: "1m", Mode: test.mode, RateLimitRemaining: 17,
					RateLimitResetAfter: 30,
				}},
			}
			handler, err := NewAPIHandler(scenario, 1)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(handler)
			defer server.Close()
			response, err := server.Client().Get(server.URL + "/repos/simulator/repo")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.want)
			}
			if test.mode == "healthy" && response.Header.Get("X-RateLimit-Remaining") != "17" {
				t.Fatalf("healthy response remaining = %q, want configured value 17",
					response.Header.Get("X-RateLimit-Remaining"))
			}
			if test.mode == "rate-limited" || test.mode == "secondary-rate-limit" {
				if response.Header.Get("Retry-After") != "30" || response.Header.Get("X-RateLimit-Remaining") != "0" {
					t.Fatalf("missing rate-limit headers: %#v", response.Header)
				}
			}
		})
	}
}

func TestFakeGitHubAPITimesOutOnClientCancellation(t *testing.T) {
	handler, err := NewAPIHandler(Scenario{
		Name: "timeout", Repositories: 1,
		API: []APIWindow{{From: "0s", To: "1m", Mode: "timeout"}},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/rate_limit", nil)
	_, err = server.Client().Do(request)
	if err == nil {
		t.Fatal("expected the simulated request to time out")
	}
}

func TestFakeGitHubAPIInterruptedConnectionAndLatency(t *testing.T) {
	for _, test := range []struct {
		name   string
		window APIWindow
	}{
		{name: "connection", window: APIWindow{From: "0s", To: "1m", Mode: "connection-failure"}},
		{name: "latency", window: APIWindow{From: "0s", To: "1m", Mode: "latency", Latency: "50ms"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler, err := NewAPIHandler(Scenario{Name: test.name, Repositories: 1, API: []APIWindow{test.window}}, 1)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(handler)
			defer server.Close()
			started := time.Now()
			response, err := server.Client().Get(server.URL + "/rate_limit")
			if test.name == "connection" {
				if err == nil {
					response.Body.Close()
					t.Fatal("expected simulated connection failure")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if elapsed := time.Since(started); elapsed < 40*time.Millisecond {
				t.Fatalf("latency mode returned after %s", elapsed)
			}
		})
	}
}

func TestGeneratedWebhookBodyStaysWithinServerLimit(t *testing.T) {
	scenario := Scenario{Name: "bounded", Repositories: 100, EventsPerRepository: 1}
	deliveries, err := scenario.Generate()
	if err != nil {
		t.Fatal(err)
	}
	for _, delivery := range deliveries {
		if len(delivery.Payload) > 1<<20 || len(delivery.ID) != 36 {
			t.Fatalf("unexpected delivery size or ID: bytes=%d id=%q", len(delivery.Payload), delivery.ID)
		}
	}
}
