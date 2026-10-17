package githubapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

func TestWebhookGatewayProjectsCurrentOrganizationAuthority(t *testing.T) {
	for _, enterprise := range []bool{false, true} {
		t.Run(fmt.Sprintf("enterprise-%t", enterprise), func(t *testing.T) {
			var requested []string
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				expectedPath := "/graphql"
				if enterprise {
					expectedPath = "/api/graphql"
				}
				if r.Method != http.MethodPost || r.URL.Path != expectedPath {
					t.Errorf("request=%s %s", r.Method, r.URL.Path)
				}
				var request struct {
					Query     string            `json:"query"`
					Variables map[string]string `json:"variables"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
				}
				if request.Query != webhookGatewayProjectQuery || len(request.Variables) != 1 {
					t.Errorf("nonstatic project identity query %+v", request)
				}
				requested = append(requested, request.Variables["id"])
				w.Header().Set("X-RateLimit-Limit", "5000")
				w.Header().Set("X-RateLimit-Remaining", "4999")
				w.Header().Set("X-RateLimit-Reset", "1800000000")
				_, _ = fmt.Fprintf(w, `{"data":{"node":{"__typename":"ProjectV2","id":%q,"owner":{"__typename":"Organization","databaseId":99}}}}`, request.Variables["id"])
			})
			if enterprise {
				client.installations[7].client.BaseURL.Path = "/api/v3/"
			}
			observed := 0
			err := client.WebhookGatewayProjectsWithQuota(context.Background(), 7, 99, []string{"PVT_one", "PVT_two="}, func(quota githubquota.ResponseQuota) {
				observed++
				if !quota.HasObservation || quota.Resource != "graphql" {
					t.Errorf("quota=%+v", quota)
				}
			})
			if err != nil || strings.Join(requested, ",") != "PVT_one,PVT_two=" || observed != 2 {
				t.Fatalf("err=%v requested=%v observed=%d", err, requested, observed)
			}
		})
	}
}

func TestWebhookGatewayProjectsRejectsUnprovenAccess(t *testing.T) {
	for _, test := range []struct {
		name, body string
		status     int
	}{
		{"null-node", `{"data":{"node":null}}`, 200},
		{"null-data", `{"data":null}`, 200},
		{"graphql-errors", `{"data":{"node":{"__typename":"ProjectV2","id":"PVT_one","owner":{"__typename":"Organization","databaseId":99}}},"errors":[{"message":"sensitive credential https://private"}]}`, 200},
		{"wrong-project", `{"data":{"node":{"__typename":"ProjectV2","id":"PVT_other","owner":{"__typename":"Organization","databaseId":99}}}}`, 200},
		{"wrong-org", `{"data":{"node":{"__typename":"ProjectV2","id":"PVT_one","owner":{"__typename":"Organization","databaseId":100}}}}`, 200},
		{"user-owner", `{"data":{"node":{"__typename":"ProjectV2","id":"PVT_one","owner":{"__typename":"User","databaseId":99}}}}`, 200},
		{"wrong-node-type", `{"data":{"node":{"__typename":"ProjectV2Item","id":"PVT_one","owner":{"__typename":"Organization","databaseId":99}}}}`, 200},
		{"missing-owner", `{"data":{"node":{"__typename":"ProjectV2","id":"PVT_one"}}}`, 200},
		{"invalid-json", `not-json sensitive credential https://private`, 200},
		{"oversized", `{"data":{"node":null},"other":"` + strings.Repeat("x", webhookGatewayResponseLimit) + `"}`, 200},
		{"not-found", `{"message":"sensitive credential"}`, 404},
		{"rate-limit", `{"message":"sensitive credential"}`, 429},
		{"server-error", `{"message":"sensitive credential"}`, 503},
		{"redirect", `{}`, 307},
	} {
		t.Run(test.name, func(t *testing.T) {
			requests := 0
			client := gatewayTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.Header().Set("Location", "/different-target")
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			})
			err := client.WebhookGatewayProjects(context.Background(), 7, 99, []string{"PVT_one", "PVT_two"})
			if err == nil || strings.Contains(err.Error(), "sensitive") || strings.Contains(err.Error(), "https:") || requests != 1 {
				t.Fatalf("err=%v requests=%d", err, requests)
			}
		})
	}
}

func TestWebhookGatewayProjectsBoundsAndCancellation(t *testing.T) {
	requests := 0
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		select {
		case <-r.Context().Done():
		case <-time.After(150 * time.Millisecond):
		}
	})
	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("PVT_%d", i)
	}
	for _, ids := range [][]string{nil, {}, {"PVT_one", "PVT_one"}, {"bad\nid"}, {strings.Repeat("x", 257)}, tooMany} {
		if err := client.WebhookGatewayProjects(context.Background(), 7, 99, ids); err == nil || requests != 0 {
			t.Fatalf("invalid IDs accepted: len=%d requests=%d err=%v", len(ids), requests, err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := client.WebhookGatewayProjects(ctx, 7, 99, []string{"PVT_one"}); err == nil {
		t.Fatal("timed-out project authority accepted")
	}
}
