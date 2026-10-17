package githubapp

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestWebhookGatewayAppRole(t *testing.T) {
	for _, test := range []struct {
		name, role, body string
		valid            bool
	}{
		{"receive-read", "receive", `{"id":11,"permissions":{"actions":"read","contents":"read","organization_projects":"read"},"events":["projects_v2_item"]}`, true},
		{"receive-actions-write", "receive", `{"id":11,"permissions":{"actions":"write"},"events":["issues"]}`, false},
		{"receive-contents-write", "receive", `{"id":11,"permissions":{"contents":"write"},"events":[]}`, false},
		{"dispatch-repository-only", "dispatch", `{"id":11,"permissions":{"actions":"write","contents":"write","metadata":"read"},"events":[]}`, true},
		{"dispatch-receives-events", "dispatch", `{"id":11,"permissions":{"actions":"write"},"events":["some_future_event"]}`, false},
		{"dispatch-org-read", "dispatch", `{"id":11,"permissions":{"organization_projects":"read"},"events":[]}`, false},
		{"dispatch-future-org", "dispatch", `{"id":11,"permissions":{"organization_future_permission":"write"},"events":[]}`, false},
		{"dispatch-members", "dispatch", `{"id":11,"permissions":{"members":"read"},"events":[]}`, false},
		{"dispatch-org-none", "dispatch", `{"id":11,"permissions":{"organization_projects":"none","actions":"write"},"events":[]}`, true},
		{"wrong-app", "dispatch", `{"id":12,"permissions":{"actions":"write"},"events":[]}`, false},
		{"missing-permissions", "dispatch", `{"id":11,"events":[]}`, false},
		{"unknown-events", "dispatch", `{"id":11,"permissions":{"actions":"write"}}`, false},
		{"invalid-level", "receive", `{"id":11,"permissions":{"actions":"future-superuser"}}`, false},
		{"invalid-role", "other", `{"id":11,"permissions":{},"events":[]}`, false},
		{"invalid-json", "dispatch", `<html>sensitive response</html>`, false},
		{"oversized", "dispatch", `{"id":11,"permissions":{},"events":[],"other":"` + strings.Repeat("x", 64<<10) + `"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			requests := 0
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != http.MethodGet || r.URL.Path != "/app" {
					t.Errorf("App role checked wrong endpoint %s %s", r.Method, r.URL.Path)
				}
				_, _ = w.Write([]byte(test.body))
			})
			err := client.ValidateWebhookGatewayRole(context.Background(), test.role)
			if (err == nil) != test.valid {
				t.Fatalf("err=%v wantValid=%t", err, test.valid)
			}
			if test.role == "other" && requests != 0 {
				t.Fatal("unknown role performed an API call")
			}
		})
	}
}

func TestWebhookGatewayAppRoleErrorsAreSanitized(t *testing.T) {
	for _, status := range []int{401, 403, 404, 429, 503} {
		client := gatewayTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"message":"sensitive credential https://private"}`))
		})
		err := client.ValidateWebhookGatewayRole(context.Background(), "dispatch")
		if err == nil || strings.Contains(err.Error(), "sensitive") || strings.Contains(err.Error(), "https:") {
			t.Fatalf("unsafe error %v", err)
		}
	}
}
