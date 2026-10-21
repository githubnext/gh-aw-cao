package webhookgateway

import (
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestProviderProjectionRetainsOnlySelectedActivities(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, original := range policy.Subscriptions {
		if !providerEvent(original.Source.Event) {
			continue
		}
		row := slices.IndexFunc(deliveries, func(row externalDeliveryFixture) bool { return row.SourceID == original.Source.ID })
		delivery := deliveries[row]
		for _, selected := range [][]string{{"closed"}, {"edited"}, {"labeled"}, {"closed", "labeled"}, {"opened"}} {
			t.Run(original.Source.Event+"/"+strings.Join(selected, ","), func(t *testing.T) {
				subscription := original
				trigger := *original.Compiler
				trigger.Types = selected
				subscription.Compiler = &trigger
				matches := compilerTriggerMatches(trigger, delivery.Payload, nativeAction(trigger.Event, delivery.Payload))
				if selected[0] == "opened" {
					if matches {
						t.Fatal("empty activity intersection matched")
					}
					return
				}
				if !matches {
					t.Fatal("selected evidence-backed activity did not match")
				}
				job := externalJob(t, policy, subscription, delivery.Payload, "selected")
				if !slices.Equal(job.Event.Activities, selected) {
					t.Fatal("unselected activities entered durable identity", job.Event.Activities)
				}
				batch, err := BuildDispatchBatch([]Job{job})
				if err != nil {
					t.Fatal(err)
				}
				var request compilerBatchRequest
				if err := json.Unmarshal(batch, &request); err != nil {
					t.Fatal(err)
				}
				var payload map[string]any
				if err := json.Unmarshal(request.Payload.AWContext.Webhook.Deliveries[0].Payload, &payload); err != nil {
					t.Fatal(err)
				}
				activities, _ := notificationActivities(payload)
				if !slices.Equal(activities, selected) {
					t.Fatal("unselected activities survived projection", activities)
				}
				filters := maps.Clone(delivery.Expected["filters"].(map[string]any))
				if trigger.Event == "azure_devops_issue" && !slices.Contains(selected, "closed") {
					delete(filters, "closed-states")
				}
				if !reflect.DeepEqual(payload["filters"], filters) {
					t.Fatal("incorrect selected filter literals", payload["filters"], filters)
				}
				unselected := "edited"
				if slices.Contains(selected, unselected) {
					unselected = "closed"
				}
				activities = append(slices.Clone(selected), unselected)
				slices.Sort(activities)
				payload["type"] = activities
				request.Payload.AWContext.Webhook.Deliveries[0].Payload, err = json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				corrupt, err := json.Marshal(request)
				if err != nil || ValidateBatchDispatchPayload(subscription, corrupt, DefaultLimits()) == nil {
					t.Fatal("unselected supported activity accepted", err)
				}
			})
		}
	}
}

func TestAzureProjectionUsesOnlyMatchingTerminalState(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.Event != "azure_devops_issue" {
			continue
		}
		for _, scenario := range []struct {
			name, before, after, terminal string
			expected                      []string
		}{
			{"enter-terminal", "Active", "Done", "Done", []string{"closed", "edited"}},
			{"leave-terminal", "Closed", "Active", "Closed", []string{"edited", "reopened"}},
			{"terminal-to-terminal", "Closed", "Done", "", []string{"edited"}},
			{"nonterminal-to-nonterminal", "Active", "Ready", "", []string{"edited"}},
			{"missing-before", "", "Done", "", []string{"edited"}},
		} {
			t.Run(scenario.name, func(t *testing.T) {
				data, err := json.Marshal(deliveries[2].Payload)
				if err != nil {
					t.Fatal(err)
				}
				var root map[string]any
				if err := json.Unmarshal(data, &root); err != nil {
					t.Fatal(err)
				}
				state := at(root, "resource", "fields", "System.State").(map[string]any)
				state["oldValue"], state["newValue"] = scenario.before, scenario.after
				if scenario.before == "" {
					delete(state, "oldValue")
				}
				trigger := *subscription.Compiler
				trigger.Types = []string{"closed", "edited", "reopened"}
				subscription.Compiler = &trigger
				job := externalJob(t, policy, subscription, root, scenario.name)
				var request struct {
					Payload struct {
						Notification map[string]any `json:"payload"`
					} `json:"client_payload"`
				}
				if err := json.Unmarshal(job.Payload, &request); err != nil {
					t.Fatal(err)
				}
				payload := request.Payload.Notification
				activities, _ := notificationActivities(payload)
				if !slices.Equal(activities, scenario.expected) {
					t.Fatal("incorrect selected transition activities", activities)
				}
				filters := payload["filters"].(map[string]any)
				if scenario.terminal == "" {
					if _, exists := filters["closed-states"]; exists {
						t.Fatal("unselected/non-lifecycle state evidence leaked")
					}
					filters["closed-states"] = []any{"Done"}
					if validCompilerFilters(trigger, payload) {
						t.Fatal("extra terminal state accepted without lifecycle activity")
					}
					return
				}
				if !reflect.DeepEqual(filters["closed-states"], []any{scenario.terminal}) {
					t.Fatal("unmatched side or whole configured terminal set survived", filters)
				}
				for _, invalid := range []any{nil, "Done", []any{}, []any{"Active"}, []any{"Done", "Closed"}, []any{"Done", "Done"}, []any{true}} {
					filters["closed-states"] = invalid
					if validCompilerFilters(trigger, payload) {
						t.Fatal("invalid terminal-state evidence accepted", invalid)
					}
				}
				delete(filters, "closed-states")
				if validCompilerFilters(trigger, payload) {
					t.Fatal("required terminal-state evidence omitted")
				}
				filters["closed-states"] = []any{scenario.terminal}
				payload["type"] = []any{"closed", "reopened"}
				if validExternalNotification(subscription, payload) {
					t.Fatal("contradictory lifecycle activities accepted")
				}
			})
		}
	}
}

func TestProviderContradictoryOriginalTransitionsNeverQualify(t *testing.T) {
	_, registry, deliveries := externalFixture(t)
	trigger := registry.Records[0].Workflows[0].Triggers[0]
	root := deliveries[0].Payload
	changes := at(root, "changelog", "items").([]any)
	root["changelog"].(map[string]any)["items"] = append(changes,
		map[string]any{"fieldtype": "jira", "field": "resolution", "from": "1", "to": nil})
	for _, selected := range [][]string{{"closed"}, {"reopened"}, {"edited"}, {"closed", "reopened"}} {
		trigger.Types = selected
		if compilerTriggerMatches(trigger, root, "jira:issue_updated") {
			t.Fatal("contradictory native transition qualified", selected)
		}
	}
}
