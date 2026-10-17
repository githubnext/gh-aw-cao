package webhookgateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestGatewayPayloadReservedProvenance(t *testing.T) {
	for _, kind := range []string{"repository_dispatch", "workflow_dispatch"} {
		t.Run(kind, func(t *testing.T) {
			subscription, snapshot := shellFixture()
			if kind == "workflow_dispatch" {
				subscription.Destination.Kind = kind
				subscription.Destination.Workflow = "project.yml"
				subscription.Destination.Ref = "main"
				subscription.Destination.EventType = ""
				subscription.Destination.GatewayInput = true
			}
			event, err := ParseEvent("delivery", "projects_v2_item",
				[]byte(`{"action":"edited","installation":{"id":10},"organization":{"id":20},"projects_v2_item":{"id":9},"_gateway":{"attacker":"spoofed"}}`),
				DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			event.SourceID = "projects"
			payload, err := buildGatewayDispatchPayload(subscription, event, snapshot.Revisions[subscription.ID], DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(payload), "spoofed") {
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
			provenance := properties["_gateway"]
			if kind == "workflow_dispatch" {
				var encoded string
				if err := json.Unmarshal(provenance, &encoded); err != nil {
					t.Fatal(err)
				}
				provenance = []byte(encoded)
			}
			var metadata struct {
				SourceID       string   `json:"sourceId"`
				DeliveryID     string   `json:"deliveryId"`
				SubscriptionID string   `json:"subscriptionId"`
				Revision       Revision `json:"revision"`
			}
			if err := json.Unmarshal(provenance, &metadata); err != nil {
				t.Fatal(err)
			}
			if metadata.SourceID != "projects" || metadata.DeliveryID != "delivery" ||
				metadata.SubscriptionID != subscription.ID || metadata.Revision.Digest != snapshot.Revisions[subscription.ID].Digest {
				t.Fatalf("incorrect provenance %+v", metadata)
			}
		})
	}
}

func TestGatewayPayloadReservedFieldCountsAgainstLimit(t *testing.T) {
	subscription, snapshot := shellFixture()
	event, err := ParseEvent("delivery", "projects_v2_item", []byte(`{"action":"edited"}`), DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = "projects"
	for _, fields := range []int{9, 10} {
		subscription.Destination.Fields = nil
		for i := range fields {
			subscription.Destination.Fields = append(subscription.Destination.Fields,
				PayloadField{Name: fmt.Sprintf("field_%d", i), Literal: json.RawMessage(`"x"`)})
		}
		_, err := buildGatewayDispatchPayload(subscription, event, snapshot.Revisions[subscription.ID], DefaultLimits())
		if fields == 9 && err != nil {
			t.Fatal(err)
		}
		if fields == 10 && !errors.Is(err, ErrInvalid) {
			t.Fatal("reserved field bypassed repository property limit")
		}
	}
}

func TestGatewayWorkflowRequiresDeclaredReservedInput(t *testing.T) {
	subscription, snapshot := shellFixture()
	subscription.Destination.Kind = "workflow_dispatch"
	subscription.Destination.EventType = ""
	subscription.Destination.Workflow = "project.yml"
	subscription.Destination.Ref = "main"
	event := Event{SourceID: "projects", DeliveryID: "delivery", Payload: json.RawMessage(`{}`)}
	if _, err := buildGatewayDispatchPayload(subscription, event, snapshot.Revisions[subscription.ID], DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("undeclared workflow input was injected")
	}
}
