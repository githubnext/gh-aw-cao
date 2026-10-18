package webhookgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	return compilerSecurityJobs(t, policy, subscription, "approved/exact", deliveries...)
}

func compilerSecurityJobs(t *testing.T, policy PolicySnapshot, subscription Subscription, repository string, deliveries ...string) []Job {
	t.Helper()
	family := strings.TrimSuffix(strings.ReplaceAll(subscription.Source.Event, "_", "-"), "-alert")
	body := []byte(fmt.Sprintf(`{"action":"created","installation":{"id":%d},"organization":{"id":%d},
		"repository":{"id":%d,"private":true,"full_name":%q},"alert":{"number":42,
		"url":"https://api.github.com/repos/%s/%s/alerts/42",
		"secret":"MUST-NOT-PERSIST","assignees":[{"login":"octocat"}],"security_advisory":{"severity":"critical"}}}`,
		subscription.Source.InstallationID, subscription.Source.OrganizationID,
		subscription.Source.RepositoryID, repository, repository, family))
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
	base, registry := discoveryFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		t.Run(subscription.Source.Event, func(t *testing.T) {
			checkCompilerBatchProvenance(t, compilerSecurityJobs(t, policy, subscription, "approved/exact", "one", "two"))
		})
	}
}

func checkCompilerBatchProvenance(t *testing.T, jobs []Job) {
	t.Helper()
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
	for _, scenario := range []string{"root-provenance", "nested-provenance", "supplied-items", "resource-details", "flat-context", "legacy", "mixed-event", "duplicate-delivery", "raw-alert", "wrong-host", "query", "credentials", "wrong-family"} {
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
			case "resource-details":
				context["resource"] = map[string]any{"title": "not-forwarded"}
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
				trigger.Dispatch.PayloadProjection = &CompilerProjection{Policy: "unknown/v1"}
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
	base, registry := discoveryFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		t.Run(subscription.Source.Event, func(t *testing.T) {
			checkCompilerRuntime(t, compilerSecurityJobs(t, policy, subscription, "approved/exact", "one", "two"))
		})
	}
}

func checkCompilerRuntime(t *testing.T, jobs []Job) {
	t.Helper()
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
const projection = request.client_payload.aw_context.webhook.deliveries[0].payload;
assert.deepEqual(Object.keys(projection).sort(), ['type', 'url']);
assert.deepEqual(projection.type, ['created']);
const subscription = JSON.parse(process.env.GH_AW_WEBHOOK_SUBSCRIPTIONS)[0];
for (const activity of subscription.types) {
  const selected = JSON.parse(JSON.stringify(event));
  selected.client_payload.aw_context.webhook.deliveries[1].payload.type = [activity];
  assert.equal(validateWebhook(selected).skipped, false);
  assert.equal(normalizeWebhookContext(selected.client_payload.aw_context).items.length, 1);
}
assert.throws(() => validateWebhook({...event, client_payload:{...request.client_payload, _gateway:{}}}));
for (const invalid of [
  {url: projection.url}, {...projection, type: 'created'}, {...projection, type: []},
  {...projection, type: ['created', 'reopened']}, {...projection, type: ['unknown']},
  {...projection, alert: {number: 42}}, {...projection, source: {id: 42}},
]) {
  const rejected = JSON.parse(JSON.stringify(event));
  rejected.client_payload.aw_context.webhook.deliveries[1].payload = invalid;
  assert.throws(() => validateWebhook(rejected));
}
for (const payload_projection of [undefined, {}, {policy: 'unknown/v1'},
  {source_path: ['alert', 'url'], target_path: ['url']},
  {policy: 'resource-url-types/v1', source_path: ['alert', 'url']}]) {
  const subscriptions = JSON.parse(process.env.GH_AW_WEBHOOK_SUBSCRIPTIONS);
  subscriptions[0].dispatch.payload_projection = payload_projection;
  assert.throws(() => validateWebhook(event, {...process.env, GH_AW_WEBHOOK_SUBSCRIPTIONS: JSON.stringify(subscriptions)}));
}
for (const key of ['items', '_gateway', 'resource']) {
  const rejected = JSON.parse(JSON.stringify(event));
  rejected.client_payload.aw_context[key] = {};
  assert.throws(() => validateWebhook(rejected));
}
`
	command := exec.CommandContext(t.Context(), "node", "-e", script)
	command.Env = append(os.Environ(), "GITHUB_EVENT_NAME=repository_dispatch", "GITHUB_API_URL=https://api.github.com",
		"GH_AW_WEBHOOK_SUBSCRIPTIONS="+string(declarations))
	command.Stdin = bytes.NewReader(payload)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("compiler runtime interoperability: %v\n%s", err, output)
	}
}

func TestCompilerSelectedSourceRuntimeInteroperability(t *testing.T) {
	if os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR") == "" {
		t.Skip("WEBHOOK_COMPILER_RUNTIME_DIR must point to a selector-capable gh-aw runtime")
	}
	base, registry := multiRepositoryRegistry(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.Event != "dependabot_alert" || subscription.Source.RepositoryID == 23 {
			continue
		}
		repository := map[int64]string{21: "bar/baz", 22: "foo/one"}[subscription.Source.RepositoryID]
		t.Run(repository, func(t *testing.T) {
			payload, err := BuildDispatchBatch(compilerSecurityJobs(t, policy, subscription, repository, "one", "two"))
			if err != nil {
				t.Fatal(err)
			}
			declarations, err := json.Marshal([]CompilerTrigger{*subscription.Compiler})
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
assert.deepEqual(validateWebhook(event).delivery_ids, ['one', 'two']);
const context = normalizeWebhookContext(request.client_payload.aw_context);
assert.equal(context.items.length, 1);
assert.equal(context.items[0].repo, process.env.EXPECTED_SOURCE_REPOSITORY);
assert.deepEqual(context.webhook.deliveries[0].payload.type, ['created']);
assert.deepEqual(Object.keys(context.webhook.deliveries[0].payload).sort(), ['type', 'url']);
for (const repository of ['bar/other', 'foobar/one', 'unselected/repo']) {
  const rejected = JSON.parse(JSON.stringify(event));
  rejected.client_payload.aw_context.webhook.deliveries[1].payload.url =
    'https://api.github.com/repos/' + repository + '/dependabot/alerts/42';
  assert.throws(() => validateWebhook(rejected));
}
`
			command := exec.CommandContext(t.Context(), "node", "-e", script)
			command.Env = append(os.Environ(), "GITHUB_EVENT_NAME=repository_dispatch", "GITHUB_API_URL=https://api.github.com",
				"GH_AW_WEBHOOK_SUBSCRIPTIONS="+string(declarations), "EXPECTED_SOURCE_REPOSITORY="+repository)
			command.Stdin = bytes.NewReader(payload)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("compiler source-selection interoperability: %v\n%s", err, output)
			}
		})
	}
}
