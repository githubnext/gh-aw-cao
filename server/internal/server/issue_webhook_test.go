package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

func TestSignedIssueWebhookRefreshesRetainedSource(t *testing.T) {
	endpoint := os.Getenv("REDIS_URL")
	if endpoint == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := redisx.New(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	store := redisx.NewStore(client, "issue-server-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	enrollment := collect.Enrollment{Store: store}
	if err := enrollment.AddRepositories(t.Context(), 42, []string{"octo/api"}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSource(t.Context(), "g1", model.Source{
		Source: "issues", Rows: []model.Row{{
			"id": "github:issue:octo/api:12", "repositoryFullName": "octo/api",
			"isPullRequest": false, "state": "OPEN",
		}}, Metadata: model.Metadata{"availability": "available"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(t.Context(), "g1", "snapshot", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	app := &App{store: store, webhookSecret: []byte("test-issue-webhook-secret"),
		reconciler: &Collector{admitter: collect.Admitter{
			Enrollment: enrollment, Queue: collect.Queue{Store: store}, IssueStore: store,
		}}}
	payload := `{"action":"closed","repository":{"full_name":"octo/api"},"installation":{"id":42},
		"issue":{"number":12,"state":"closed","state_reason":"completed",
		"closed_at":"2026-01-02T03:04:06Z","updated_at":"2026-01-02T03:04:06Z",
		"html_url":"https://github.com/octo/api/issues/12"}}`
	send := func(body, delivery string, signed bool) map[string]any {
		t.Helper()
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost,
			"/api/github/webhook", strings.NewReader(body))
		request.Header.Set("X-GitHub-Event", "issues")
		request.Header.Set("X-GitHub-Delivery", delivery)
		if signed {
			mac := hmac.New(sha256.New, app.webhookSecret)
			_, _ = mac.Write([]byte(body))
			request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		}
		response := httptest.NewRecorder()
		app.githubWebhook(response, request)
		if !signed {
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("unsigned webhook returned %d", response.Code)
			}
			return nil
		}
		if response.Code != http.StatusAccepted {
			t.Fatalf("webhook returned %d: %s", response.Code, response.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	send(payload, "delivery-1", false)
	if result := send(payload, "delivery-1", true); result["applied"] != true || result["queued"] != false {
		t.Fatalf("signed issue was not applied: %+v", result)
	}
	if result := send(payload, "delivery-1", true); result["duplicate"] != true {
		t.Fatalf("duplicate delivery was applied: %+v", result)
	}
	source, _, err := store.LoadSource(t.Context(), "g1", "issues", nil)
	if err != nil || source.Rows[0]["state"] != "CLOSED" ||
		source.Rows[0]["stateReason"] != "completed" || source.Rows[0]["closed"] != true {
		t.Fatalf("issue source did not refresh: %+v (%v)", source, err)
	}
	active, err := store.Active(t.Context())
	if err != nil || active.Revision != 2 {
		t.Fatalf("duplicate or unsigned webhook changed revision: %+v (%v)", active, err)
	}

	repository := "simulator/repo-00001"
	if err := enrollment.AddRepositories(t.Context(), 1, []string{repository}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSource(t.Context(), "g2", model.Source{
		Source: "issues", Rows: []model.Row{{
			"id": "github:issue:" + repository + ":1", "repositoryFullName": repository,
			"isPullRequest": false, "state": "UNKNOWN",
		}}, Metadata: model.Metadata{"availability": "available"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(t.Context(), "g2", "simulator-snapshot", time.Now(), map[string]int{"issues": 1}); err != nil {
		t.Fatal(err)
	}
	deliveries, err := (simulator.Scenario{
		Name: "issue-status-source", Repositories: 1, IssueEventsPerRepository: 4, Seed: 7,
	}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	for _, delivery := range deliveries {
		if delivery.Event != "issues" {
			continue
		}
		var event struct {
			Action string `json:"action"`
			Issue  struct {
				UpdatedAt string `json:"updated_at"`
				ClosedAt  any    `json:"closed_at"`
			} `json:"issue"`
		}
		if err := json.Unmarshal(delivery.Payload, &event); err != nil {
			t.Fatal(err)
		}
		if result := send(string(delivery.Payload), delivery.ID, true); result["applied"] != true || result["queued"] != false {
			t.Fatalf("%s was not applied to existing source: %+v", event.Action, result)
		}
		loaded, _, err := store.LoadSource(t.Context(), "g2", "issues", nil)
		if err != nil || len(loaded.Rows) != 1 {
			t.Fatalf("%s source unavailable: %+v (%v)", event.Action, loaded, err)
		}
		row := loaded.Rows[0]
		closed := event.Action == "closed"
		wantState := "OPEN"
		if closed {
			wantState = "CLOSED"
		}
		observed, err := time.Parse(time.RFC3339Nano, event.Issue.UpdatedAt)
		if err != nil {
			t.Fatal(err)
		}
		if row["state"] != wantState || row["closed"] != closed ||
			row["statusObservedAt"] != observed.UTC().Format("2006-01-02T15:04:05.000000000Z") {
			t.Fatalf("%s source status mismatch: %+v", event.Action, row)
		}
		if closed {
			if row["stateReason"] != "completed" || row["closedAt"] != event.Issue.ClosedAt {
				t.Fatalf("closed issue fields missing: %+v", row)
			}
		} else if row["stateReason"] != nil || row["closedAt"] != nil {
			t.Fatalf("%s retained stale closing fields: %+v", event.Action, row)
		}
	}
	depth, err := store.StreamLength(t.Context(), "collect:tasks")
	if err != nil || depth != 0 {
		t.Fatalf("issue events enqueued workflow collection: depth=%d err=%v", depth, err)
	}
	active, err = store.Active(t.Context())
	if err != nil || active.Revision != 7 {
		t.Fatalf("issue lifecycle did not advance live revision: %+v (%v)", active, err)
	}
}
