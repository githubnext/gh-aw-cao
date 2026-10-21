package webhookgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func notificationFixture(t *testing.T, family string) (PolicySnapshot, RegistrySnapshot, PolicySnapshot, Subscription) {
	t.Helper()
	base, registry := discoveryFixture(t)
	base.Policy.Discovery.ActivateSecurity = false
	base.Policy.Discovery.ActivateNotifications = true
	trigger := registry.Records[0].Workflows[0].Triggers[0]
	definition := notifications.Events[family]
	trigger.Event, trigger.Types = family, slices.Clone(definition.Actions)
	trigger.NativeEvents, trigger.Conditions = []string{definition.Native}, []CompilerCondition{}
	trigger.AnyOf, trigger.Repos, trigger.Orgs = nil, []string{"approved/exact"}, []string{"approved"}
	data, err := json.Marshal(map[string]any{"version": 1, "webhook_subscriptions": []CompilerTrigger{trigger}})
	if err != nil {
		t.Fatal(err)
	}
	artifact := append([]byte("# gh-aw-manifest: "), data...)
	triggers, err := ParseWorkflowManifest(artifact, trigger.Dispatch.Workflow, DefaultLimits())
	if err != nil {
		t.Fatal("notification manifest", err)
	}
	registry.Records[0].Workflows[0].Triggers = []CompilerTrigger{triggers[0].Declaration}
	registry.Records[0].Workflows[0].SHA256 = MetadataDigest(artifact)
	refreshRegistryDigest(t, &registry)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil || len(policy.Subscriptions) != 1 {
		t.Fatal("reviewed notification fixture did not activate", err)
	}
	return base, registry, policy, policy.Subscriptions[0]
}

func notificationOriginal(t *testing.T, s Subscription, action string) Event {
	t.Helper()
	definition := notifications.Events[s.Source.Event]
	number := "42"
	if definition.Path == "commit" {
		number = strings.Repeat("a", 40)
	}
	resource := s.Source.ServerURL + "/approved/exact/" + definition.Path + "/" + number
	if definition.Anchor != "" {
		resource += "#" + definition.Anchor + "99"
	}
	parent := map[string]any{"number": 42, "html_url": resource, "state": "open", "draft": false, "merged": true,
		"labels": []any{map[string]any{"name": "keep"}, map[string]any{"name": "MUST-NOT-PERSIST"}},
		"user":   map[string]any{"login": "author"}, "assignees": []any{map[string]any{"login": "assigned"}},
		"category": map[string]any{"slug": "ideas"}, "base": map[string]any{"ref": "main"}, "head": map[string]any{"ref": "feature"}}
	root := map[string]any{"action": action, "installation": map[string]any{"id": s.Source.InstallationID},
		"organization": map[string]any{"id": s.Source.OrganizationID, "login": "approved"},
		"repository":   map[string]any{"id": s.Source.RepositoryID, "private": true, "full_name": "approved/exact"},
		"sender":       map[string]any{"login": "sender"}, "label": map[string]any{"name": "keep"}}
	switch {
	case definition.IssueKind != "":
		root["issue"] = parent
		if definition.IssueKind == "pull_request" {
			parent["pull_request"] = map[string]any{}
		}
	case definition.Path == "discussions":
		root["discussion"] = parent
	case definition.Path == "pull":
		root["pull_request"] = parent
	}
	comment := map[string]any{"id": 99, "html_url": resource, "commit_id": number,
		"path": "src/main.go", "user": map[string]any{"login": "author"}, "state": "approved"}
	switch s.Source.Event {
	case "pull_request_review":
		root["review"] = comment
	case "pull_request_review_thread":
		root["thread"] = map[string]any{"id": 123, "comments": []any{comment, map[string]any{"path": "MUST-NOT-PERSIST"}}}
	default:
		if definition.Anchor != "" {
			root["comment"] = comment
		}
	}
	root["body"] = "MUST-NOT-PERSIST"
	return notificationEvent(t, s, root)
}

func notificationEvent(t *testing.T, s Subscription, root any) Event {
	t.Helper()
	body, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	event, err := ParseEvent("notification-"+s.Source.Event+"-"+textAt(root, "action"),
		notifications.Events[s.Source.Event].Native, body, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = CompilerSourceID
	return event
}

func TestNotificationCatalogAllActionsSurviveDurableAdmissionAndBatching(t *testing.T) {
	for family, definition := range notifications.Events {
		_, _, policy, s := notificationFixture(t, family)
		for _, action := range definition.Actions {
			t.Run(family+"/"+action, func(t *testing.T) {
				event := notificationOriginal(t, s, action)
				matched, err := MatchSubscription(s, event, DefaultLimits())
				if err != nil || !matched {
					t.Fatal("original notification did not match", err)
				}
				job := commandJob(t, policy, s, event)
				batch, err := BuildDispatchBatch([]Job{job})
				if err != nil || job.Event.Name != family || job.Event.CommandEvent != "" ||
					bytes.Contains(batch, []byte("MUST-NOT-PERSIST")) ||
					CompilerBatchRepository(s, batch, "APPROVED/EXACT") != nil ||
					CompilerBatchRepository(s, batch, "approved/other") == nil {
					t.Fatal("notification projection/source binding", err)
				}
				var durable Job
				data, err := json.Marshal(job)
				if err != nil || json.Unmarshal(data, &durable) != nil || ValidateJob(durable) != nil ||
					bytes.Contains(data, []byte("MUST-NOT-PERSIST")) {
					t.Fatal("durable notification retained source body or lost identity", err)
				}
			})
		}
	}
}

func TestNotificationsRequireSeparateReviewedActivationAndSourceAuthority(t *testing.T) {
	for _, scenario := range []string{"default-off", "commands-only", "security-only", "public", "dirty", "stale", "outside-scope", "not-org", "wrong-org", "withdrawn"} {
		t.Run(scenario, func(t *testing.T) {
			base, registry, policy, s := notificationFixture(t, "pull_request_comment")
			switch scenario {
			case "default-off", "withdrawn":
				base.Policy.Discovery.ActivateNotifications = false
			case "commands-only":
				base.Policy.Discovery.ActivateNotifications, base.Policy.Discovery.ActivateCommands = false, true
			case "security-only":
				base.Policy.Discovery.ActivateNotifications, base.Policy.Discovery.ActivateSecurity = false, true
			case "public":
				registry.Records[0].Visibility = "public"
			case "dirty":
				registry.Records[0].Dirty = true
			case "stale":
				registry.Records[0].CheckedAt = time.Now().Add(-time.Hour)
			case "outside-scope":
				base.Policy.Discovery.Repositories[0].Repository = "approved/other"
			case "not-org":
				registry.Records[0].OwnerType = "User"
			case "wrong-org":
				registry.Records[0].Workflows[0].Triggers[0].Orgs = []string{"other"}
			}
			if scenario == "withdrawn" {
				policy.Policy.Discovery = base.Policy.Discovery
				if policy.CompilerSourceAllowed(s) {
					t.Fatal("withdrawn notification activation remained authorized")
				}
			}
			refreshRegistryDigest(t, &registry)
			resolved, err := RegistryPolicy(base, registry, time.Now())
			if err == nil && len(resolved.Subscriptions) != 0 {
				t.Fatal("notification inferred source activation")
			}
		})
	}
	_, _, _, s := notificationFixture(t, "pull_request")
	if !maps.Equal(s.Source.RequiredPermissions, map[string]string{"contents": "read", "pull_requests": "read"}) ||
		RequiresLabelRemoval(s) {
		t.Fatal("notification inferred command/write permissions")
	}
}

func TestNotificationConditionsMatchOnlyCatalogPathsTypesAndActualLiterals(t *testing.T) {
	for family, definition := range notifications.Events {
		_, _, policy, s := notificationFixture(t, family)
		event := notificationOriginal(t, s, definition.Actions[0])
		filters := maps.Clone(notifications.Common)
		maps.Copy(filters, definition.Filters)
		for name, filter := range filters {
			t.Run(family+"/"+name, func(t *testing.T) {
				subscription, trigger := s, *s.Compiler
				subscription.Compiler = &trigger
				if len(filter.Actions) > 0 {
					event = notificationOriginal(t, s, filter.Actions[0])
				}
				var operand any
				switch name {
				case "sender":
					operand = "sender"
				case "organization":
					operand = "approved"
				case "repository":
					operand = "approved/exact"
				case "number":
					operand = 42
				case "state":
					operand = "open"
					if family == "pull_request_review" {
						operand = "approved"
					}
				case "labels", "label":
					operand = "keep"
				case "author":
					operand = "author"
				case "assignee":
					operand = "assigned"
				case "category":
					operand = "ideas"
				case "draft":
					operand = false
				case "merged":
					operand = true
				case "base":
					operand = "main"
				case "head":
					operand = "feature"
				case "path":
					operand = "src/main.go"
				case "commit":
					operand = strings.Repeat("a", 40)
				default:
					t.Fatal("uncovered filter", name)
				}
				raw, _ := json.Marshal(operand)
				trigger.Conditions = []CompilerCondition{{Filter: name, Path: filter.Path, Operator: "equals", ValueType: filter.Type, Values: []json.RawMessage{raw}}}
				if validateCompilerTrigger(trigger, trigger.Dispatch.Workflow, "test", DefaultLimits()) != nil {
					t.Fatal("published typed filter rejected")
				}
				job := commandJob(t, policy, subscription, event)
				batch, err := BuildDispatchBatch([]Job{job})
				if err != nil || bytes.Contains(batch, []byte("MUST-NOT-PERSIST")) {
					t.Fatal("nonmatching array literals escaped", err)
				}
				var request compilerBatchRequest
				_ = json.Unmarshal(batch, &request)
				var projection map[string]any
				_ = json.Unmarshal(request.Payload.AWContext.Webhook.Deliveries[0].Payload, &projection)
				expected, _ := json.Marshal(map[string]any{name: []any{operand}})
				actual, _ := json.Marshal(projection["filters"])
				if !bytes.Equal(expected, actual) {
					t.Fatalf("incorrect matching literal projection: %s", actual)
				}
				assertNotificationRuntime(t, subscription, batch)
				trigger.Conditions[0].Path = []string{"body"}
				if validateNotificationDeclaration(trigger) == nil {
					t.Fatal("noncatalog source path accepted")
				}
			})
		}
	}
}

func TestNotificationCanonicalOriginalEvidenceFailsClosed(t *testing.T) {
	for family, definition := range notifications.Events {
		_, _, _, s := notificationFixture(t, family)
		for _, scenario := range []string{"wrong-number", "wrong-id", "foreign-repository", "origin", "base-path", "query", "anchor", "missing-url", "wrong-parent", "null-pr", "scalar-pr", "array-pr", "missing-first-comment", "unknown-action"} {
			t.Run(family+"/"+scenario, func(t *testing.T) {
				event := notificationOriginal(t, s, definition.Actions[0])
				root, err := boundedJSON(event.Payload, DefaultLimits().MaxEventBytes, DefaultLimits())
				if err != nil {
					t.Fatal(err)
				}
				object := root.(map[string]any)
				value, exists := lookup(root, "/"+strings.Join(definition.URLPath[:len(definition.URLPath)-1], "/"), DefaultLimits())
				if !exists {
					t.Fatal("fixture missing URL parent")
				}
				resource := value.(map[string]any)
				url := resource["html_url"].(string)
				switch scenario {
				case "wrong-number":
					resource["html_url"] = strings.Replace(url, "/42", "/43", 1)
					if definition.Path == "commit" {
						resource["html_url"] = strings.Replace(url, strings.Repeat("a", 40), strings.Repeat("b", 40), 1)
					}
				case "wrong-id":
					if definition.Anchor == "" {
						return
					}
					resource["id"] = 100
				case "foreign-repository":
					resource["html_url"] = strings.Replace(url, "/approved/exact/", "/approved/other/", 1)
				case "origin":
					resource["html_url"] = strings.Replace(url, "https://github.com", "https://other.example", 1)
				case "base-path":
					resource["html_url"] = strings.Replace(url, "/approved/", "/github/approved/", 1)
				case "query":
					resource["html_url"] = url + "?body=secret"
				case "anchor":
					resource["html_url"] = strings.Split(url, "#")[0] + "#pullrequestreview-7"
				case "missing-url":
					delete(resource, "html_url")
				case "wrong-parent":
					switch {
					case definition.Path == "commit":
						delete(resource, "commit_id")
					case definition.IssueKind != "":
						delete(object, "issue")
					case definition.Path == "pull":
						delete(object, "pull_request")
					default:
						delete(object, "discussion")
					}
				case "null-pr", "scalar-pr", "array-pr":
					if definition.IssueKind == "" {
						return
					}
					issue := object["issue"].(map[string]any)
					issue["pull_request"] = map[string]any{"null-pr": nil, "scalar-pr": true, "array-pr": []any{}}[scenario]
				case "missing-first-comment":
					if family != "pull_request_review_thread" {
						return
					}
					object["thread"] = map[string]any{"comments": []any{}}
				case "unknown-action":
					object["action"] = "unsupported"
				}
				event = notificationEvent(t, s, object)
				if _, err := BuildDispatchPayload(s, event, DefaultLimits()); err == nil {
					t.Fatal("unbound original notification evidence projected")
				}
			})
		}
	}
}

func TestNotificationBodylessActionsNeverWidenCommands(t *testing.T) {
	_, _, _, command := commandFixture(t, "slash_command")
	for _, test := range []struct{ family, action string }{{"pull_request", "ready_for_review"}, {"pull_request", "review_requested"}, {"pull_request_review", "submitted"}} {
		_, _, _, notification := notificationFixture(t, test.family)
		event := notificationOriginal(t, notification, test.action)
		if matched, err := MatchSubscription(command, event, DefaultLimits()); err != nil || matched {
			t.Fatal("bodyless notification widened slash activation", err)
		}
	}
}

func TestNotificationIngressNativeSplitAndDurableFailure(t *testing.T) {
	for _, family := range []string{"issue_comment", "pull_request_comment", "pull_request_review_thread"} {
		_, _, policy, s := notificationFixture(t, family)
		event := notificationOriginal(t, s, s.Compiler.Types[0])
		if family == "pull_request_comment" {
			_, _, _, other := notificationFixture(t, "issue_comment")
			policy.Subscriptions = append(policy.Subscriptions, other)
		}
		for _, fail := range []bool{false, true} {
			queue := &shellQueue{}
			if fail {
				queue.admitErr = errors.New("unavailable")
			}
			handler := &Ingress{SourceID: CompilerSourceID, Secrets: shellSecrets{}, Policies: shellPolicy{snapshot: policy},
				Queue: queue, Authorizer: &shellAuthorizer{}}
			request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/webhooks/compiler", bytes.NewReader(event.Payload))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-GitHub-Delivery", event.DeliveryID)
			request.Header.Set("X-GitHub-Event", event.Name)
			request.Header.Set("X-Hub-Signature-256", signWebhook(event.Payload, []byte("current")))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			expected := http.StatusAccepted
			if fail {
				expected = http.StatusServiceUnavailable
			}
			if response.Code != expected || len(queue.admission.Jobs) != 1 || queue.admission.Jobs[0].Event.Name != family {
				t.Fatalf("%s admission HTTP %d, want %d", family, response.Code, expected)
			}
		}
	}
}

func TestNotificationSelectedTypesAndChangedLabelApplicability(t *testing.T) {
	_, _, _, s := notificationFixture(t, "issues")
	trigger := *s.Compiler
	s.Compiler = &trigger
	trigger.Types = []string{"opened", "labeled"}
	trigger.Conditions = []CompilerCondition{stringCondition("label", []string{"label", "name"}, "keep")}
	for _, action := range []string{"opened", "labeled", "unlabeled"} {
		event := notificationOriginal(t, s, action)
		matched, err := MatchSubscription(s, event, DefaultLimits())
		if err != nil || matched != (action == "labeled") {
			t.Fatal("selected action/changed-label filtering", action, err)
		}
	}
}

func TestNotificationMetadataStrictAndGenericEnrollmentExcluded(t *testing.T) {
	for _, family := range slices.Sorted(maps.Keys(notifications.Events)) {
		_, _, _, s := notificationFixture(t, family)
		for _, mutate := range []func(*CompilerTrigger){
			func(t *CompilerTrigger) { t.Provider = "github" },
			func(t *CompilerTrigger) { t.NativeEvents = []string{"other"} },
			func(t *CompilerTrigger) {
				t.AnyOf = [][]CompilerCondition{{stringCondition("sender", []string{"sender", "login"}, "sender")}}
			},
			func(t *CompilerTrigger) { t.Types = []string{"unsupported"} },
			func(t *CompilerTrigger) { t.SchemaVersion = 1 },
			func(t *CompilerTrigger) {
				t.Conditions = []CompilerCondition{stringCondition("state", []string{"review", "state"}, "unknown")}
			},
		} {
			trigger := *s.Compiler
			mutate(&trigger)
			if validateCompilerTrigger(trigger, trigger.Dispatch.Workflow, "test", DefaultLimits()) == nil {
				t.Fatal("invalid notification metadata accepted", family)
			}
		}
	}
	base, _, _ := externalFixture(t)
	source := base.Policy.ExternalSources[0]
	source.Event, source.Scope = "webhook", ""
	if validateExternalSource(source) == nil {
		t.Fatal("retired arbitrary source enrollment activated")
	}
	data, _ := json.Marshal(map[string]any{"id": source.ID, "event": "webhook", "types": []string{"com.example.release"}, "urlPath": "/data/url"})
	var restored ExternalSource
	if json.Unmarshal(data, &restored) == nil {
		t.Fatal("retired arbitrary source survived policy/durable restoration")
	}
	if !maps.Equal(notificationPermissions("commit_comment"), map[string]string{"contents": "read"}) {
		t.Fatal("commit notification needs unexpected permissions")
	}
}
