package githubapp

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type labelTestTransport struct{ destination *url.URL }

func (t labelTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	resource := *request.URL
	resource.Host, resource.Scheme = t.destination.Host, t.destination.Scheme
	copy.URL = &resource
	return http.DefaultTransport.RoundTrip(copy)
}

func labelAPISubscription(t *testing.T, event string) gateway.Subscription {
	t.Helper()
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-commands-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Triggers []gateway.CompilerTrigger `json:"webhook_subscriptions"`
	}
	if json.Unmarshal(data, &manifest) != nil || len(manifest.Triggers) != 2 {
		t.Fatal("invalid command fixture")
	}
	trigger := manifest.Triggers[1]
	trigger.CommandFilter.Events, trigger.NativeEvents = []string{event}, []string{event}
	s := gatewayTestSubscription("repository_dispatch")
	s.Source.ID, s.Source.Event, s.Source.ServerURL = gateway.CompilerSourceID, "label_command", "https://github.com"
	s.Source.RequiredPermissions = map[string]string{"contents": "read", "issues": "write"}
	switch event {
	case "pull_request":
		s.Source.RequiredPermissions = map[string]string{"contents": "read", "pull_requests": "write"}
	case "discussion":
		s.Source.RequiredPermissions = map[string]string{"contents": "read", "discussions": "write"}
	}
	s.Compiler, s.Destination.Fields, s.Destination.EventType = &trigger, nil, trigger.Dispatch.EventType
	if err := gateway.ValidateSubscription(s, gateway.DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestGatewayConsumesOnlyTheApprovedLabelAfterDurableReservation(t *testing.T) {
	for _, event := range []string{"issues", "pull_request", "discussion"} {
		for _, denied := range []bool{false, true} {
			t.Run(event+map[bool]string{true: "/denied", false: "/allowed"}[denied], func(t *testing.T) {
				var before, mutations, queries int
				s := labelAPISubscription(t, event)
				kind := map[string]string{"issues": "issues", "pull_request": "pull", "discussion": "discussions"}[event]
				target := gateway.LabelRemoval{Repository: "current/renamed", Number: 42, Label: "ready / deploy", Event: event,
					URL: "https://github.com/current/renamed/" + kind + "/42"}
				client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
					if gatewayAuthorityResponse(w, r) {
						return
					}
					if event == "discussion" {
						if r.Method != http.MethodPost || r.URL.Path != "/graphql" {
							t.Error("unapproved GraphQL endpoint")
						}
						var input struct {
							Query string `json:"query"`
						}
						if json.NewDecoder(r.Body).Decode(&input) != nil {
							t.Error("invalid GraphQL request")
						}
						if strings.HasPrefix(input.Query, "query") {
							queries++
							_, _ = w.Write([]byte(`{"data":{"repository":{"databaseId":42,"nameWithOwner":"current/renamed","isPrivate":true,"discussion":{"id":"D_42","number":42,"url":"https://github.com/current/renamed/discussions/42"},"label":{"id":"L_ready","name":"ready / deploy"}}}}`))
							return
						}
						_, _ = w.Write([]byte(`{"data":{"removeLabelsFromLabelable":{"labelable":{"id":"D_42"}}}}`))
					} else {
						if r.Method != http.MethodDelete || r.URL.EscapedPath() != "/repos/current/renamed/issues/42/labels/ready%20%2F%20deploy" {
							t.Errorf("wrong label route: %s %s", r.Method, r.URL.EscapedPath())
						}
						w.WriteHeader(http.StatusNoContent)
					}
					if before != 1 {
						t.Error("write preceded durable admission/reservation")
					}
					mutations++
				})
				destination, _ := url.Parse(client.config.BaseURL)
				client.config.BaseURL = ""
				client.config.Transport = labelTestTransport{destination}
				err := client.WebhookGatewayConsumeLabel(t.Context(), s, target, func() error {
					before++
					if denied {
						return gateway.ErrUnauthorized
					}
					return nil
				}, func(githubquota.ResponseQuota) {})
				if denied {
					if !errors.Is(err, gateway.ErrUnauthorized) || mutations != 0 {
						t.Fatal("denied label mutation executed", err)
					}
				} else if err != nil || mutations != 1 || before != 1 || event == "discussion" && queries != 1 {
					t.Fatal("authorized consumption failed", err)
				}
			})
		}
	}
}

func TestGatewayLabelWritesRejectUnselectedLiteralsAndOrigins(t *testing.T) {
	client := gatewayTestClient(t, func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("invalid write target reached GitHub")
	})
	for _, scenario := range []string{"label", "event", "origin"} {
		s := labelAPISubscription(t, "issues")
		target := gateway.LabelRemoval{Repository: "current/renamed", Number: 42, Label: "ready", Event: "issues",
			URL: "https://github.com/current/renamed/issues/42"}
		switch scenario {
		case "label":
			target.Label = "unselected"
		case "event":
			target.Event = "discussion"
		case "origin":
			s.Source.ServerURL = "https://other.example"
		}
		if client.WebhookGatewayConsumeLabel(t.Context(), s, target, func() error {
			t.Error("unapproved write attempted")
			return nil
		}, func(githubquota.ResponseQuota) {}) == nil {
			t.Fatal("unselected literal or origin accepted")
		}
	}
}
