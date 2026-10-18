package webhookgateway

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func compilerBatchJobs(t *testing.T, deliveries ...string) []Job {
	t.Helper()
	base, registry := discoveryFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var subscription Subscription
	for _, candidate := range policy.Subscriptions {
		if candidate.Source.Event == "dependabot_alert" {
			subscription = candidate
		}
	}
	body := []byte(`{"action":"created","installation":{"id":10},"organization":{"id":12},
		"repository":{"id":11,"private":true,"full_name":"approved/exact"},"alert":{"number":42,
		"url":"https://api.github.com/repos/approved/exact/dependabot/alerts/42",
		"secret":"MUST-NOT-PERSIST","security_advisory":{"severity":"critical"}}}`)
	jobs := make([]Job, 0, len(deliveries))
	for _, delivery := range deliveries {
		event, err := ParseEvent(delivery, subscription.Source.Event, body, DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		event.SourceID = CompilerSourceID
		job, err := NewJob(time.Now(), "job-"+delivery, event, subscription, policy.Revisions[subscription.ID].Digest)
		if err != nil {
			t.Fatal(err)
		}
		job.Payload, err = buildGatewayDispatchPayload(subscription, event, policy.Revisions[subscription.ID], DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		job.QueueRevision = policy.Revision
		jobs = append(jobs, job)
	}
	return jobs
}

func TestCompilerBatchPreservesDeliveriesAndOutOfBandRevision(t *testing.T) {
	jobs := compilerBatchJobs(t, "one", "two")
	payload, err := BuildDispatchBatch(jobs)
	if err != nil {
		t.Fatal(err)
	}
	var request compilerBatchRequest
	if json.Unmarshal(payload, &request) != nil || len(request.Payload.AWContext.Webhook.Deliveries) != 2 ||
		bytes.Contains(payload, []byte("_gateway")) || bytes.Contains(payload, []byte("MUST-NOT-PERSIST")) {
		t.Fatal("compiler transport lost delivery identities or leaked private metadata")
	}
	revision, err := DispatchRevision(jobs)
	if err != nil || revision.Digest != jobs[0].SubscriptionDigest ||
		ValidateCompilerRevision(jobs[0].Subscription, revision) != nil {
		t.Fatal("durable provenance did not bind out-of-band approval", err)
	}
	jobs[1].Payload = bytes.ReplaceAll(jobs[1].Payload, []byte(strings.Repeat("c", 40)), []byte(strings.Repeat("b", 40)))
	if _, err := BuildDispatchBatch(jobs); err == nil {
		t.Fatal("batch crossed full approved artifact revisions")
	}
}

func TestCompilerBatchRejectsUnagreedEnvelopesAndURLs(t *testing.T) {
	job := compilerBatchJobs(t, "one")[0]
	payload, err := BuildDispatchBatch([]Job{job})
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"root-provenance", "nested-provenance", "supplied-items", "flat-context", "legacy", "mixed-event", "duplicate-delivery", "raw-alert", "wrong-host", "query", "credentials", "wrong-family"} {
		t.Run(scenario, func(t *testing.T) {
			var request map[string]any
			if err := json.Unmarshal(payload, &request); err != nil {
				t.Fatal(err)
			}
			p := request["client_payload"].(map[string]any)
			context := p["aw_context"].(map[string]any)
			webhook := context["webhook"].(map[string]any)
			delivery := webhook["deliveries"].([]any)[0].(map[string]any)
			projection := delivery["payload"].(map[string]any)
			switch scenario {
			case "root-provenance":
				p["_gateway"] = map[string]any{}
			case "nested-provenance":
				context["_gateway"] = map[string]any{}
			case "supplied-items":
				context["items"] = []any{}
			case "flat-context":
				p["aw_context"] = []any{projection}
			case "legacy":
				p["schema_version"] = 1
			case "mixed-event":
				delivery["event"] = "code_scanning_alert"
			case "duplicate-delivery":
				webhook["deliveries"] = []any{delivery, delivery}
			case "raw-alert":
				projection["secret"] = "not-allowed"
			case "wrong-host":
				projection["url"] = "https://example.com/repos/approved/exact/dependabot/alerts/42"
			case "query":
				projection["url"] = projection["url"].(string) + "?extra=value"
			case "credentials":
				projection["url"] = "https://user@api.github.com/repos/approved/exact/dependabot/alerts/42"
			case "wrong-family":
				projection["url"] = "https://api.github.com/repos/approved/exact/code-scanning/alerts/42"
			}
			corrupt, _ := json.Marshal(request)
			if ValidateBatchDispatchPayload(job.Subscription, corrupt, DefaultLimits()) == nil {
				t.Fatal("invalid compiler batch accepted")
			}
		})
	}
}

func TestCompilerBatchDeclarationNegotiation(t *testing.T) {
	for _, scenario := range []string{"legacy-path", "missing-batch", "wrong-mode", "wrong-dedup", "missing-projection", "wrong-projection", "unsupported-event"} {
		t.Run(scenario, func(t *testing.T) {
			job := compilerBatchJobs(t, "one")[0]
			trigger := *job.Subscription.Compiler
			switch scenario {
			case "legacy-path":
				trigger.Dispatch.Context.Payload = "github.event.client_payload.payload"
			case "missing-batch":
				trigger.Dispatch.Batch = nil
			case "wrong-mode":
				trigger.Dispatch.Batch = &CompilerBatch{Mode: "mixed-events", DeduplicateBy: "delivery_id"}
			case "wrong-dedup":
				trigger.Dispatch.Batch = &CompilerBatch{Mode: "same-event", DeduplicateBy: "item_id"}
			case "missing-projection":
				trigger.Dispatch.PayloadProjection = nil
			case "wrong-projection":
				trigger.Dispatch.PayloadProjection = &CompilerProjection{SourcePath: []string{"alert"}, TargetPath: []string{"payload"}}
			case "unsupported-event":
				trigger.Event = "secret_scanning_alert"
			}
			if validateCompilerTrigger(trigger, ".github/workflows/test.lock.yml", "test", DefaultLimits()) == nil {
				t.Fatal("unnegotiated compiler batch declaration accepted")
			}
		})
	}
}

func TestCompilerBatchRuntimeInteroperability(t *testing.T) {
	directory := os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR")
	if directory == "" {
		t.Skip("WEBHOOK_COMPILER_RUNTIME_DIR must point to the pinned gh-aw runtime")
	}
	jobs := compilerBatchJobs(t, "one", "two")
	payload, err := BuildDispatchBatch(jobs)
	if err != nil {
		t.Fatal(err)
	}
	declarations, err := json.Marshal([]CompilerTrigger{*jobs[0].Subscription.Compiler})
	if err != nil {
		t.Fatal(err)
	}
	const script = `
const assert = require('node:assert/strict');
const path = require('node:path');
const {validateWebhook} = require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR, 'validate_webhook.cjs'));
const {normalizeWebhookContext} = require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR, 'webhook_context.cjs'));
const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const event = {action: request.event_type, client_payload: request.client_payload};
const result = validateWebhook(event);
assert.deepEqual(result.delivery_ids, ['one', 'two']);
const context = normalizeWebhookContext(request.client_payload.aw_context);
assert.equal(context.webhook.deliveries.length, 2);
assert.equal(context.items.length, 1);
assert.equal(context.items[0].item_number, '42');
assert.equal(context.items[0].repo, 'approved/exact');
assert.throws(() => validateWebhook({...event, client_payload:{...request.client_payload, _gateway:{}}}));
`
	command := exec.CommandContext(t.Context(), "node", "-e", script)
	command.Env = append(os.Environ(), "GITHUB_EVENT_NAME=repository_dispatch", "GITHUB_API_URL=https://api.github.com",
		"GH_AW_WEBHOOK_SUBSCRIPTIONS="+string(declarations))
	command.Stdin = bytes.NewReader(payload)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("compiler runtime interoperability: %v\n%s", err, output)
	}
}
