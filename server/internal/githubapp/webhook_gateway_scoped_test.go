package githubapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

func TestWebhookGatewayRepositoryFreshScopedMintProvesMembership(t *testing.T) {
	mints, lookups, posts := 0, 0, 0
	deny := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/app/installations/7/access_tokens":
			mints++
			var options struct {
				RepositoryIDs []int64 `json:"repository_ids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&options); err != nil {
				t.Error(err)
			}
			if len(options.RepositoryIDs) != 1 || options.RepositoryIDs[0] != 42 ||
				!strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
				t.Errorf("mint did not request exact approved repository: %+v", options)
			}
			w.Header().Set("X-RateLimit-Limit", "5000")
			w.Header().Set("X-RateLimit-Remaining", "4998")
			w.Header().Set("X-RateLimit-Reset", "1800000000")
			if deny {
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"repository_ids contains a repository outside this installation"}`))
				return
			}
			_, _ = fmt.Fprintf(w, `{"token":%q,"expires_at":%q}`, fmt.Sprintf("repo-scoped-%d", mints), time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/api/v3/repositories/42":
			lookups++
			if r.Header.Get("Authorization") != fmt.Sprintf("token repo-scoped-%d", mints) {
				t.Error("repository lookup reused a previous authority token")
			}
			_, _ = w.Write([]byte(`{"id":42,"full_name":"owner/public","owner":{"id":99},"visibility":"public","private":false}`))
		case "/api/v3/repos/owner/public/dispatches":
			posts++
			if r.Header.Get("Authorization") != fmt.Sprintf("token repo-scoped-%d", mints) {
				t.Error("dispatch did not reuse this attempt's scoped token")
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected inventory/discovery route %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	client, err := New(Config{AppID: 11, PrivateKeyPEM: gatewayTestKey(t), BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, _, err := client.WebhookGatewayRepository(context.Background(), 7, 42); err != nil {
			t.Fatal(err)
		}
	}
	subscription := gatewayTestSubscription("repository_dispatch")
	dispatcher := WebhookGatewayDispatcher{Client: client}
	response := dispatcher.Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.StatusCode != 204 || mints != 3 || lookups != 3 || posts != 1 {
		t.Fatalf("response=%+v mints=%d lookups=%d posts=%d", response, mints, lookups, posts)
	}
	// A public GET would still succeed, but a new scoped mint now rejects the
	// target. Never fall back to its cached token or public readability.
	deny = true
	var quota githubquota.ResponseQuota
	dispatcher.ObserveQuota = func(_ context.Context, _ int64, value githubquota.ResponseQuota) error {
		quota = value
		return nil
	}
	response = dispatcher.Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.TransportOutcome != "not-sent" || mints != 4 || lookups != 3 || posts != 1 ||
		!quota.HasObservation || quota.Observation.Remaining != 4998 || quota.ParkUntil.IsZero() {
		t.Fatalf("denied scope reached public lookup/dispatch: response=%+v mints=%d lookups=%d posts=%d quota=%+v", response, mints, lookups, posts, quota)
	}
}
