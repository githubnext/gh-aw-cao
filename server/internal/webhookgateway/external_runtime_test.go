package webhookgateway

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestExternalPublishedRuntimeInteroperability(t *testing.T) {
	if os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR") == "" {
		t.Skip("WEBHOOK_COMPILER_RUNTIME_DIR must point to the published gh-aw runtime")
	}
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		t.Run(compilerTriggerKey(*subscription.Compiler), func(t *testing.T) {
			row := slices.IndexFunc(deliveries, func(row externalDeliveryFixture) bool { return row.SourceID == subscription.Source.ID })
			root := deliveries[row].Payload
			if subscription.Source.Event == "webhook" {
				root["type"] = subscription.Compiler.Types[0]
			}
			jobs := []Job{externalJob(t, policy, subscription, root, "one"), externalJob(t, policy, subscription, root, "two")}
			payload, err := BuildDispatchBatch(jobs)
			if err != nil {
				t.Fatal(err)
			}
			declarations, err := json.Marshal([]CompilerTrigger{*subscription.Compiler})
			if err != nil {
				t.Fatal(err)
			}
			const script = `
const assert = require('node:assert/strict'), path = require('node:path');
const {validateWebhook} = require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR, 'validate_webhook.cjs'));
const {normalizeWebhookContext} = require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR, 'webhook_context.cjs'));
const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const event = {action: request.event_type, client_payload: request.client_payload};
assert.equal(validateWebhook(event).skipped, false);
assert.deepEqual(validateWebhook(event).delivery_ids, ['one', 'two']);
const normalized = normalizeWebhookContext(request.client_payload.aw_context);
assert.equal(normalized.items.length, 1);
assert.equal(normalized.items[0].repo, '');
assert.equal(normalized.items[0].url, normalized.webhook.deliveries[0].payload.url);
if (normalized.webhook.event === 'webhook') assert.equal(normalized.items[0].item_number, '');
for (const invalid of [
  {...event.client_payload, _gateway: {}},
  {...event.client_payload, aw_context: {...event.client_payload.aw_context, items: []}},
]) assert.throws(() => validateWebhook({...event, client_payload: invalid}));
const original = normalized.webhook.deliveries[0].payload;
for (const invalid of [{url: original.url}, {...original, title:'forbidden'}, {...original, type:['unknown']}]) {
  const rejected = JSON.parse(JSON.stringify(event));
  rejected.client_payload.aw_context.webhook.deliveries[0].payload = invalid;
  assert.throws(() => validateWebhook(rejected));
}
`
			command := exec.CommandContext(t.Context(), "node", "-e", script)
			command.Env = append(os.Environ(), "GITHUB_EVENT_NAME=repository_dispatch",
				"GH_AW_WEBHOOK_SUBSCRIPTIONS="+string(declarations))
			command.Stdin = bytes.NewReader(payload)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("published compiler runtime rejected external batch: %v\n%s", err, output)
			}
		})
	}
}

func TestProviderTransitionEvidenceMatchesPublishedNormalizer(t *testing.T) {
	if os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR") == "" {
		t.Skip("WEBHOOK_COMPILER_RUNTIME_DIR must point to the published gh-aw runtime")
	}
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	type vector struct {
		Trigger CompilerTrigger `json:"trigger"`
		Payload map[string]any  `json:"payload"`
	}
	var vectors []vector
	for _, subscription := range policy.Subscriptions {
		if !providerEvent(subscription.Source.Event) {
			continue
		}
		row := slices.IndexFunc(deliveries, func(row externalDeliveryFixture) bool { return row.SourceID == subscription.Source.ID })
		for _, scenario := range []string{"original", "created", "deleted", "restored", "no-transition", "reopened", "unknown-state", "ambiguous-labels", "wrong-entity"} {
			data, err := json.Marshal(deliveries[row].Payload)
			if err != nil {
				t.Fatal(err)
			}
			var root map[string]any
			if err := json.Unmarshal(data, &root); err != nil {
				t.Fatal(err)
			}
			activity := subscription.Source.Event
			switch scenario {
			case "created", "deleted", "restored":
				native := providerNativeForActivity(activity, map[string]string{"created": "opened", "deleted": "deleted", "restored": "restored"}[scenario])
				if native == "" {
					continue
				}
				field := map[string]string{"jira_issue": "webhookEvent", "linear_issue": "action", "azure_devops_issue": "eventType"}[activity]
				root[field] = native
			case "no-transition":
				delete(root, "changelog")
				delete(root, "updatedFrom")
				if resource, ok := root["resource"].(map[string]any); ok {
					delete(resource, "fields")
				}
			case "unknown-state":
				switch activity {
				case "jira_issue":
					at(root, "changelog", "items").([]any)[0].(map[string]any)["fieldtype"] = "custom"
				case "linear_issue":
					at(root, "updatedFrom").(map[string]any)["completedAt"] = "unknown"
				default:
					delete(at(root, "resource", "fields", "System.State").(map[string]any), "oldValue")
				}
			case "reopened":
				switch activity {
				case "jira_issue":
					change := at(root, "changelog", "items").([]any)[0].(map[string]any)
					change["from"], change["to"] = "10000", nil
				case "linear_issue":
					at(root, "data").(map[string]any)["completedAt"] = nil
					at(root, "updatedFrom").(map[string]any)["completedAt"] = "2026-01-01T00:00:00Z"
				default:
					state := at(root, "resource", "fields", "System.State").(map[string]any)
					state["oldValue"], state["newValue"] = "Closed", "Active"
				}
			case "ambiguous-labels":
				switch activity {
				case "jira_issue":
					at(root, "issue", "fields").(map[string]any)["labels"] = []any{"one", "two"}
				case "linear_issue":
					at(root, "updatedFrom").(map[string]any)["labelIds"] = "not-an-array"
				default:
					at(root, "resource", "fields", "System.Tags").(map[string]any)["oldValue"] = nil
				}
			case "wrong-entity":
				if activity != "linear_issue" {
					continue
				}
				root["type"] = "IssueLabel"
			}
			vectors = append(vectors, vector{Trigger: *subscription.Compiler, Payload: root})
		}
	}
	input, err := json.Marshal(vectors)
	if err != nil {
		t.Fatal(err)
	}
	const script = `
const path = require('node:path');
const {providerIssueActivities} = require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR, 'provider_issue_webhook.cjs'));
const input = JSON.parse(require('node:fs').readFileSync(0,'utf8'));
console.log(JSON.stringify(input.map(({trigger, payload}) => {
  try { return [...new Set(providerIssueActivities(trigger.event, payload, trigger.activity_normalization))].sort(); }
  catch { return null; }
})));
`
	command := exec.CommandContext(t.Context(), "node", "-e", script)
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("published provider normalizer failed: %v\n%s", err, output)
	}
	var expected [][]string
	if err := json.Unmarshal(output, &expected); err != nil || len(expected) != len(vectors) {
		t.Fatal("invalid reference normalization results", err)
	}
	for i, row := range vectors {
		if got := providerActivities(row.Trigger, row.Payload); !reflect.DeepEqual(got, expected[i]) {
			t.Fatalf("normalization vector %d (%s): got %v, expected %v", i, row.Trigger.Event, got, expected[i])
		}
	}
}
