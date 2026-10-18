package webhookgateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayPayloadContainsOnlyCanonicalURL(t *testing.T) {
	for _, kind := range []string{"repository_dispatch", "workflow_dispatch"} {
		t.Run(kind, func(t *testing.T) {
			subscription, snapshot := shellFixture()
			if kind == "workflow_dispatch" {
				subscription.Destination.Kind = kind
				subscription.Destination.Workflow = "project.yml"
				subscription.Destination.Ref = "main"
				subscription.Destination.EventType = ""
			}
			event, err := ParseEvent("delivery", "issues",
				[]byte(`{"action":"edited","installation":{"id":10},"organization":{"id":20},"issue":{"id":9,"url":"https://api.github.com/repos/approved/source/issues/9","body":"private"},"_gateway":{"attacker":"spoofed"}}`),
				DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			event.SourceID = "projects"
			payload, err := buildGatewayDispatchPayload(subscription, event, snapshot.Revisions[subscription.ID], DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(payload), "spoofed") || strings.Contains(string(payload), "private") {
				t.Fatal("untrusted metadata propagated")
			}
			// Decode only the nested properties, since workflow requests also have ref.
			var envelope map[string]json.RawMessage
			if err := json.Unmarshal(payload, &envelope); err != nil {
				t.Fatal(err)
			}
			property := "client_payload"
			if kind == "workflow_dispatch" {
				property = "inputs"
			}
			var properties map[string]json.RawMessage
			if err := json.Unmarshal(envelope[property], &properties); err != nil {
				t.Fatal(err)
			}
			if len(properties) != 1 || string(properties["url"]) != `"https://api.github.com/repos/approved/source/issues/9"` {
				t.Fatalf("dispatch forwarded more than the event resource URL: %s", payload)
			}
		})
	}
}

func TestGatewayPayloadRejectsMissingURLBeforeAdmission(t *testing.T) {
	subscription, snapshot := shellFixture()
	event, err := ParseEvent("delivery", "issues", []byte(`{"action":"edited"}`), DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = "projects"
	if _, err := buildGatewayDispatchPayload(subscription, event, snapshot.Revisions[subscription.ID], DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing resource URL accepted")
	}
	queue, authorizer := &shellQueue{}, &shellAuthorizer{}
	handler := Ingress{SourceID: "projects", Policies: shellPolicy{snapshot: snapshot}, Secrets: shellSecrets{}, Queue: queue, Authorizer: authorizer}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, shellRequest(`{"action":"edited","installation":{"id":10},"organization":{"id":20},"issue":{"id":9}}`))
	if response.Code != http.StatusBadRequest || authorizer.calls != 0 || len(queue.admission.Jobs) != 0 {
		t.Fatal("missing URL triggered authorization or durable admission")
	}
}

func TestGatewayRejectsLegacyPayloadMappings(t *testing.T) {
	subscription, _ := shellFixture()
	data, err := json.Marshal(subscription)
	if err != nil {
		t.Fatal(err)
	}
	for _, legacy := range []string{`"fields":[{"name":"body","path":"/issue/body","required":true}],`, `"gatewayInput":true,`} {
		raw := strings.Replace(string(data), `"destination":{`, `"destination":{`+legacy, 1)
		if _, err := ParseSubscription([]byte(raw), DefaultLimits()); !errors.Is(err, ErrInvalid) {
			t.Fatal("legacy data-forwarding contract accepted")
		}
	}
}
