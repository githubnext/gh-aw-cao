package webhookgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCompilerProjectionPolicyIsRequiredForEveryDeclaredFamily(t *testing.T) {
	triggers, err := ParseWorkflowManifest(batchManifestFixture(t), ".github/workflows/test.lock.yml", DefaultLimits())
	if err != nil || len(triggers) != 3 {
		t.Fatal("invalid projection policy fixture", err)
	}
	_, registry, _ := externalFixture(t)
	for _, declaration := range registry.Records[0].Workflows[0].Triggers {
		triggers = append(triggers, WorkflowTrigger{Declaration: declaration})
	}
	for _, trigger := range triggers {
		t.Run(trigger.Declaration.Event, func(t *testing.T) {
			for _, policy := range []string{"", "unknown/v1", "resource-url-types/v1", "resource-url-types/v2", "resource-url-types-filters/v1"} {
				declaration := trigger.Declaration
				declaration.Dispatch.PayloadProjection = &CompilerProjection{Policy: policy}
				if validateCompilerTrigger(declaration, declaration.Dispatch.Workflow, "test", DefaultLimits()) == nil {
					t.Fatalf("unsupported projection policy activated: %q", policy)
				}
			}
			declaration := trigger.Declaration
			declaration.Dispatch.PayloadProjection = nil
			if validateCompilerTrigger(declaration, declaration.Dispatch.Workflow, "test", DefaultLimits()) == nil {
				t.Fatal("missing projection policy activated")
			}
			declaration = trigger.Declaration
			declaration.Types = []string{"unknown?"}
			if validateCompilerTrigger(declaration, declaration.Dispatch.Workflow, "test", DefaultLimits()) == nil {
				t.Fatal("unsupported activity entered a minimal notification")
			}
		})
	}
	fixture := string(batchManifestFixture(t))
	for _, projection := range []string{
		`{}`, `null`, `{"policy":"unknown/v1"}`,
		`{"source_path":["alert","url"],"target_path":["url"]}`,
		`{"policy":"resource-url-types-filters/v2","source_path":["alert","url"]}`,
	} {
		data := strings.ReplaceAll(fixture, `{"policy":"resource-url-types-filters/v2"}`, projection)
		if _, err := ParseWorkflowManifest([]byte(data), ".github/workflows/test.lock.yml", DefaultLimits()); err == nil {
			t.Fatalf("unsupported projection declaration accepted: %s", projection)
		}
	}
}

func TestCompilerMinimalNotificationsRejectMissingAndExtraData(t *testing.T) {
	job := compilerBatchJobs(t, "one")[0]
	batch, err := BuildDispatchBatch([]Job{job})
	if err != nil {
		t.Fatal(err)
	}
	url := "https://api.github.com/repos/approved/exact/dependabot/alerts/42"
	for _, scenario := range []struct {
		name    string
		payload map[string]any
	}{
		{"url-only", map[string]any{"url": url}},
		{"missing-url", map[string]any{"type": []string{"created"}}},
		{"string-type", map[string]any{"url": url, "type": "created"}},
		{"empty-types", map[string]any{"url": url, "type": []string{}}},
		{"multiple-types", map[string]any{"url": url, "type": []string{"created", "reopened"}}},
		{"duplicate-types", map[string]any{"url": url, "type": []string{"created", "created"}}},
		{"unknown-type", map[string]any{"url": url, "type": []string{"unknown"}}},
		{"unselected-type", map[string]any{"url": url, "type": []string{"fixed"}}},
		{"native-body", map[string]any{"url": url, "type": []string{"created"}, "alert": map[string]any{"number": 42}}},
		{"resource-details", map[string]any{"url": url, "type": []string{"created"}, "title": "not-forwarded"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var request compilerBatchRequest
			if err := json.Unmarshal(batch, &request); err != nil {
				t.Fatal(err)
			}
			projection, err := json.Marshal(scenario.payload)
			if err != nil {
				t.Fatal(err)
			}
			request.Payload.AWContext.Webhook.Deliveries[0].Payload = projection
			corrupt, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			if ValidateBatchDispatchPayload(job.Subscription, corrupt, DefaultLimits()) == nil {
				t.Fatal("invalid minimal notification accepted")
			}
		})
	}
}

func TestCompilerProjectionDoesNotExpandSupportedFamilies(t *testing.T) {
	job := compilerBatchJobs(t, "one")[0]
	for _, event := range []string{"secret_scanning_alert", "unknown"} {
		trigger := *job.Subscription.Compiler
		trigger.Event = event
		trigger.Types = []string{"created"}
		if validateCompilerTrigger(trigger, trigger.Dispatch.Workflow, "test", DefaultLimits()) == nil {
			t.Fatal("projection policy activated an unsupported family", event)
		}
	}
}

func TestCompilerGenericWebhookDeclarationsUseDistinctIdentifiers(t *testing.T) {
	security := *compilerBatchJobs(t, "one")[0].Subscription.Compiler
	release := security
	release.Event, release.Repos = "webhook", nil
	release.Types = []string{"com.example.release"}
	release.Conditions = []CompilerCondition{{
		Filter: "data.state", Path: []string{"data", "state"}, Operator: "equals",
		ValueType: "string", Values: []json.RawMessage{json.RawMessage(`"ready"`)},
	}}
	deploy := release
	deploy.Types = []string{"com.example.deploy"}
	for _, scenario := range []struct {
		name         string
		declarations []CompilerTrigger
	}{
		{"single-identifier", []CompilerTrigger{release}},
		{"distinct-identifiers", []CompilerTrigger{release, deploy}},
		{"mixed-security-generic", []CompilerTrigger{security, release}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			manifest, err := json.Marshal(map[string]any{"version": 1, "webhook_subscriptions": scenario.declarations})
			if err != nil {
				t.Fatal(err)
			}
			mapping := NewTriggerMapping()
			err = mapping.AddWorkflow(append([]byte("# gh-aw-manifest: "), manifest...), security.Dispatch.Workflow, DefaultLimits())
			if err != nil || len(mapping.ByEvent) != len(scenario.declarations) {
				t.Fatal("distinct generic identifiers conflicted in discovery", err)
			}
		})
	}
}

func TestCompilerDurableProjectionBindsOriginalActivity(t *testing.T) {
	job := compilerBatchJobs(t, "one")[0]
	if !bytes.Contains(job.Payload, []byte(`"type":["created"]`)) {
		t.Fatal("original action was not projected")
	}
	for _, scenario := range []string{"legacy-url-only", "different-selected-activity"} {
		t.Run(scenario, func(t *testing.T) {
			corrupt := job
			if scenario == "legacy-url-only" {
				corrupt.Payload = bytes.ReplaceAll(job.Payload, []byte(`"type":["created"],`), nil)
			} else {
				corrupt.Payload = bytes.ReplaceAll(job.Payload, []byte(`"type":["created"]`), []byte(`"type":["reopened"]`))
			}
			if bytes.Equal(corrupt.Payload, job.Payload) {
				t.Fatal("invalid corruption fixture")
			}
			if !errors.Is(ValidateJob(corrupt), ErrInvalid) {
				t.Fatal("invalid durable notification accepted")
			}
			if _, err := BuildDispatchBatch([]Job{corrupt}); !errors.Is(err, ErrInvalid) {
				t.Fatal("invalid retained notification entered a batch")
			}
		})
	}
}

func TestCompilerFiltersOriginalDeliveryBeforeMinimalProjection(t *testing.T) {
	base, registry := discoveryFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		jobs := compilerSecurityJobs(t, policy, subscription, "approved/exact", "one")
		var stored struct {
			ClientPayload struct {
				Projection map[string]any `json:"payload"`
			} `json:"client_payload"`
		}
		decoder := json.NewDecoder(bytes.NewReader(jobs[0].Payload))
		decoder.UseNumber()
		if err := decoder.Decode(&stored); err != nil ||
			!reflect.DeepEqual(stored.ClientPayload.Projection["type"], []any{"created"}) ||
			len(stored.ClientPayload.Projection) != 3 ||
			!validCompilerFilters(*subscription.Compiler, stored.ClientPayload.Projection) {
			t.Fatal("durable payload was not exactly URL, original action and matching filter literals", err)
		}
		family := strings.TrimSuffix(strings.ReplaceAll(subscription.Source.Event, "_", "-"), "-alert")
		raw := []byte(`{"action":"created","installation":{"id":10},"organization":{"id":12},
			"repository":{"id":11,"private":true,"full_name":"approved/exact"},"alert":{"number":42,
			"url":"https://api.github.com/repos/approved/exact/` + family + `/alerts/42",
			"assignees":[],"security_advisory":{"severity":"low"}}}`)
		event, err := ParseEvent("excluded", subscription.Source.Event, raw, DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		event.SourceID = CompilerSourceID
		if matched, err := MatchSubscription(subscription, event, DefaultLimits()); err != nil || matched {
			t.Fatalf("original nonmatching fields bypassed receiver filtering: %v %v", matched, err)
		}
		if _, err := NewJob(time.Now(), "excluded", event, subscription, policy.Revisions[subscription.ID].Digest); err == nil {
			t.Fatal("projection replaced original receiver-side condition checks")
		}
	}
}
