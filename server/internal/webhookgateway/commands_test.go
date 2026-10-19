package webhookgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"slices"
	"testing"
	"time"
)

func commandFixture(t *testing.T, family string) (PolicySnapshot, RegistrySnapshot, PolicySnapshot, Subscription) {
	t.Helper()
	base, registry := discoveryFixture(t)
	base.Policy.Discovery.ActivateSecurity = false
	base.Policy.Discovery.ActivateCommands = true
	base.Policy.Discovery.Repositories[0].AllowLabelRemoval = true
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-commands-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	artifact := []byte("# gh-aw-manifest: " + compact.String() + "\nname: command-fixture\n")
	triggers, err := ParseWorkflowManifest(artifact, ".github/workflows/test.lock.yml", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	workflow := &registry.Records[0].Workflows[0]
	workflow.SHA256 = MetadataDigest(artifact)
	workflow.Triggers = nil
	for _, trigger := range triggers {
		workflow.Triggers = append(workflow.Triggers, trigger.Declaration)
	}
	refreshRegistryDigest(t, &registry)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.Event == family {
			return base, registry, policy, subscription
		}
	}
	t.Fatal("command did not activate under explicit fixture authority")
	return PolicySnapshot{}, RegistrySnapshot{}, PolicySnapshot{}, Subscription{}
}

func commandOriginal(t *testing.T, s Subscription, semantic, action, content string) Event {
	t.Helper()
	definition := commandEvents[semantic]
	item := map[string]any{"number": 42, "body": content,
		"html_url": s.Source.ServerURL + "/approved/exact/" + definition.kind + "/42"}
	root := map[string]any{"action": action, "installation": map[string]any{"id": s.Source.InstallationID},
		"organization":  map[string]any{"id": s.Source.OrganizationID},
		"repository":    map[string]any{"id": s.Source.RepositoryID, "private": true, "full_name": "approved/exact"},
		definition.item: item, "label": map[string]any{"name": content}}
	if semantic == "pull_request_comment" {
		item["pull_request"] = map[string]any{"url": "https://api.github.com/repos/approved/exact/pulls/42"}
	}
	if definition.anchor != "" {
		root["comment"] = map[string]any{"id": 99, "body": content,
			"html_url": item["html_url"].(string) + "#" + definition.anchor + "99"}
	}
	body, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	event, err := ParseEvent("delivery-"+semantic, definition.native, body, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = CompilerSourceID
	return event
}

func commandJob(t *testing.T, policy PolicySnapshot, s Subscription, event Event) Job {
	t.Helper()
	revision := policy.Revisions[s.ID]
	job, err := NewJob(time.Now(), "job-"+event.DeliveryID, event, s, revision.Digest)
	if err != nil {
		t.Fatal(err)
	}
	job.Payload, err = buildGatewayDispatchPayload(s, event, revision, DefaultLimits())
	job.QueueRevision = policy.Revision
	if err != nil || ValidateJob(job) != nil {
		t.Fatal("invalid durable command", err)
	}
	return job
}

func TestCommandCatalogFiltersOriginalEventsAndProjectsOnlyActualLiterals(t *testing.T) {
	for _, family := range []string{"slash_command", "label_command"} {
		_, _, policy, s := commandFixture(t, family)
		for _, semantic := range s.Compiler.CommandFilter.Events {
			definition := commandEvents[semantic]
			actions := definition.actions
			content := "/review arguments-MUST-NOT-PERSIST"
			literal, key := "review", "command"
			if family == "label_command" {
				actions, content, literal, key = []string{"labeled"}, "ready", "ready", "label"
			}
			for _, action := range actions {
				t.Run(family+"/"+semantic+"/"+action, func(t *testing.T) {
					event := commandOriginal(t, s, semantic, action, content)
					job := commandJob(t, policy, s, event)
					payload, err := BuildDispatchBatch([]Job{job})
					if err != nil || job.Event.Name != family || job.Event.CommandEvent != semantic ||
						bytes.Contains(payload, []byte("MUST-NOT-PERSIST")) || bytes.Contains(payload, []byte("body")) ||
						bytes.Contains(payload, []byte("_gateway")) {
						t.Fatal("original contents or native family escaped the receiver", err)
					}
					var request compilerBatchRequest
					if json.Unmarshal(payload, &request) != nil {
						t.Fatal("invalid envelope")
					}
					var notification map[string]any
					if json.Unmarshal(request.Payload.AWContext.Webhook.Deliveries[0].Payload, &notification) != nil {
						t.Fatal("invalid notification")
					}
					filters := notification["filters"].(map[string]any)
					if filters["event"].([]any)[0] != semantic || filters[key].([]any)[0] != literal ||
						CompilerBatchRepository(s, payload, "APPROVED/EXACT") != nil ||
						CompilerBatchRepository(s, payload, "approved/other") == nil {
						t.Fatal("command source or actual matching literal was not bound")
					}
				})
			}
			event := commandOriginal(t, s, semantic, "deleted", content)
			if matched, err := MatchSubscription(s, event, DefaultLimits()); err != nil || matched {
				t.Fatal("unsupported original action matched", err)
			}
		}
	}
}

func TestSlashTokenMatchesNativePositionAndWildcardSemantics(t *testing.T) {
	for _, test := range []struct{ body, token string }{
		{"/review", "review"}, {"/review args", "review"}, {"/Review", "Review"}, {"/x.y-z_1\nsecret", "x.y-z_1"},
		{"/review\u00a0args", "review"}, {"/review\ufeffargs", "review"}, {"/review\u2028args", "review"},
		{" /review", ""}, {"\n/review", ""}, {"text /review", ""}, {"/review!", ""}, {"/review/extra", ""},
		{"/_review", ""}, {"/.review", ""}, {"/réview", ""}, {"/review\u0085args", ""}, {"/review\u200bargs", ""},
	} {
		if got := slashToken(test.body); got != test.token {
			t.Errorf("token for %q: %q, want %q", test.body, got, test.token)
		}
	}
	for _, test := range []struct {
		pattern, token string
		match          bool
	}{{"review", "review", true}, {"review", "Review", false}, {"*", "Review", true},
		{"bot-*", "bot-", true}, {"bot-*", "bot-fix", true}, {"bot-*", "bot", false}, {"*", "", false}} {
		if matchesCommandName(test.pattern, test.token) != test.match {
			t.Fatalf("wildcard mismatch: %+v", test)
		}
	}
}

func TestCommandEventSplitAndLabelExactness(t *testing.T) {
	_, _, _, s := commandFixture(t, "slash_command")
	s.Compiler.CommandFilter.Events = []string{"issue_comment"}
	s.Compiler.NativeEvents, s.Compiler.Types = []string{"issue_comment"}, []string{"created", "edited"}
	s.Source.RequiredPermissions = commandPermissions(*s.Compiler)
	for _, semantic := range []string{"issue_comment", "pull_request_comment"} {
		event := commandOriginal(t, s, semantic, "created", "/bot-fix args")
		matched, err := MatchSubscription(s, event, DefaultLimits())
		if err != nil || matched != (semantic == "issue_comment") {
			t.Fatal("issue/PR split lost", err)
		}
	}
	_, _, _, s = commandFixture(t, "label_command")
	for _, label := range []string{"ready", "Ready", "ready-extra", "ready / deploy", " ready"} {
		event := commandOriginal(t, s, "issues", "labeled", label)
		matched, err := MatchSubscription(s, event, DefaultLimits())
		if err != nil || matched != slices.Contains([]string{"ready", "ready / deploy"}, label) {
			t.Fatal("label match was not exact", err)
		}
	}
}

func TestCommandAdmissionIsSeparatelyReviewedAndLabelWritesAreExplicit(t *testing.T) {
	for _, scenario := range []string{"disabled", "no-write", "outside-org", "outside-repo", "unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			base, registry, _, _ := commandFixture(t, "label_command")
			switch scenario {
			case "disabled":
				base.Policy.Discovery.ActivateCommands = false
				base.Policy.Discovery.Repositories[0].AllowLabelRemoval = false
			case "no-write":
				base.Policy.Discovery.Repositories[0].AllowLabelRemoval = false
			case "outside-org", "outside-repo":
				for i := range registry.Records[0].Workflows[0].Triggers {
					trigger := &registry.Records[0].Workflows[0].Triggers[i]
					if scenario == "outside-org" {
						trigger.Orgs = []string{"other"}
					} else {
						trigger.Repos = []string{"other/*"}
					}
				}
			case "unavailable":
				registry.Records[0].Dirty = true
			}
			refreshRegistryDigest(t, &registry)
			result, err := RegistryPolicy(base, registry, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			for _, subscription := range result.Subscriptions {
				if !result.CommandSourceAllowed(subscription) {
					t.Fatal("registry published an unauthorized command")
				}
				if subscription.Source.Event == "label_command" {
					t.Fatal("unreviewed label write activated")
				}
			}
		})
	}
}

func TestCommandNotificationsRejectUnboundURLsAndSideChannels(t *testing.T) {
	_, _, policy, s := commandFixture(t, "slash_command")
	job := commandJob(t, policy, s, commandOriginal(t, s, "pull_request_review_comment", "created", "/review"))
	batch, err := BuildDispatchBatch([]Job{job})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range [][2]string{
		{"https://github.com", "https://evil.example"}, {"/pull/42", "/issues/42"},
		{"#discussion_r99", "#issuecomment-99"}, {"#discussion_r99", "#pullrequestreview-99"},
		{"#discussion_r99", ""}, {"#discussion_r99", "#discussion_r99?extra=1"},
		{`"command":["review"]`, `"command":["review","other"]`},
		{`"command":["review"]`, `"command":["unselected"]`},
		{`"event":["pull_request_review_comment"]`, `"event":["issue_comment"]`},
		{`"type":["created"]`, `"type":["opened"]`},
		{`"filters":{`, `"body":"secret","filters":{`},
		{`"filters":{`, `"filters":{"arguments":["secret"],`},
	} {
		mutated := bytes.ReplaceAll(batch, []byte(change[0]), []byte(change[1]))
		if bytes.Equal(mutated, batch) || ValidateBatchDispatchPayload(s, mutated, DefaultLimits()) == nil {
			t.Fatalf("unbound command accepted: %q", change[1])
		}
	}
	for _, identity := range []string{"issues", "pull_request_review"} {
		mutated := job
		mutated.Event.CommandEvent = identity
		if ValidateJob(mutated) == nil {
			t.Fatal("durable semantic identity changed without rejection")
		}
	}
}

func TestCommandIngressCommitsBeforeAnyWriteAndNeverPersistsText(t *testing.T) {
	_, _, policy, s := commandFixture(t, "label_command")
	event := commandOriginal(t, s, "issues", "labeled", "ready")
	for _, failStorage := range []bool{false, true} {
		queue := &shellQueue{}
		if failStorage {
			queue.admitErr = errors.New("unavailable")
		}
		authorizer := &shellAuthorizer{}
		handler := &Ingress{SourceID: CompilerSourceID, Secrets: shellSecrets{}, Policies: shellPolicy{snapshot: policy},
			Queue: queue, Authorizer: authorizer}
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/webhooks/compiler", bytes.NewReader(event.Payload))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-GitHub-Delivery", event.DeliveryID)
		request.Header.Set("X-GitHub-Event", event.Name)
		request.Header.Set("X-Hub-Signature-256", signWebhook(event.Payload, []byte("current")))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		expected := http.StatusAccepted
		if failStorage {
			expected = http.StatusServiceUnavailable
		}
		if response.Code != expected || len(queue.admission.Jobs) != 1 ||
			queue.admission.Jobs[0].Event.Name != "label_command" {
			t.Fatalf("command admission HTTP %d, want %d", response.Code, expected)
		}
	}
}

func TestSlashMatcherParityWithPublishedRuntime(t *testing.T) {
	dir := os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR")
	if dir == "" {
		t.Skip("set WEBHOOK_COMPILER_RUNTIME_DIR for published matcher conformance")
	}

	bodies := []string{"/review", "/Review args", "/bot-fix arg", "/review\u00a0args", "/review\ufeffx",
		"/review\u0085args", "/review\u200bargs", " /review", "/review!", "/bot-", "/9._-"}
	for _, names := range [][]string{{"review", "bot-*"}, {"*"}, {"review*"}} {
		input, _ := json.Marshal(map[string]any{"bodies": bodies, "names": names})
		const script = `const m=require(require('node:path').join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,'slash_command_matcher.cjs'));const x=JSON.parse(require('node:fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(x.bodies.map(s=>m.resolveMatchedCommand(s,x.names))));`
		cmd := exec.CommandContext(t.Context(), "node", "-e", script)
		cmd.Stdin = bytes.NewReader(input)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatal("published matcher execution failed", err, string(output))
		}
		var native []string
		if json.Unmarshal(output, &native) != nil || len(native) != len(bodies) {
			t.Fatal("invalid published matcher output")
		}
		for i, body := range bodies {
			token := slashToken(body)
			if !slices.ContainsFunc(names, func(pattern string) bool { return matchesCommandName(pattern, token) }) {
				token = ""
			}
			if token != native[i] {
				t.Fatalf("native matcher differs for %q", body)
			}
		}
	}
}

type commandDispatchStub struct {
	queue *shellQueue
	calls int
}

func (d *commandDispatchStub) Dispatch(context.Context, Subscription, json.RawMessage) DispatchResponse {
	return DispatchResponse{TransportOutcome: "not-sent"}
}

func (d *commandDispatchStub) DispatchCompiler(_ context.Context, _ Subscription, _ json.RawMessage, _ Revision) DispatchResponse {
	d.calls++
	d.queue.calls = append(d.queue.calls, "http")
	return DispatchResponse{StatusCode: 204, TransportOutcome: "response"}
}

type commandConsumeStub struct {
	queue *shellQueue
	err   error
}

func (c commandConsumeStub) ConsumeLabels(_ context.Context, jobs []Job) error {
	if jobs[0].State != Dispatching || c.queue.job.State != Dispatching {
		return ErrConflict
	}
	c.queue.calls = append(c.queue.calls, "consume")
	return c.err
}

func TestCommandWorkerConsumesOnlyAfterDurableBeginAndBeforeDispatch(t *testing.T) {
	for _, scenario := range []string{"confirmed", "ambiguous", "missing-consumer"} {
		_, _, policy, s := commandFixture(t, "label_command")
		job := commandJob(t, policy, s, commandOriginal(t, s, "issues", "labeled", "ready"))
		job.State, job.ClaimID, job.Fence, job.LeaseUntil = Claimed, "batch.command", 1, time.Now().Add(time.Minute)
		queue := &shellQueue{job: &job}
		dispatch := &commandDispatchStub{queue: queue}
		worker := Worker{Policies: shellPolicy{snapshot: policy}, Queue: queue, Authorizer: &shellAuthorizer{},
			Dispatcher: dispatch, Owner: "worker", LabelConsumer: commandConsumeStub{queue: queue}}
		switch scenario {
		case "ambiguous":
			worker.LabelConsumer = commandConsumeStub{queue: queue, err: ErrUnavailable}
		case "missing-consumer":
			worker.LabelConsumer = nil
		}
		worked, err := worker.RunOnce(t.Context())
		if !worked || (err == nil) != (scenario == "confirmed") {
			t.Fatal("incorrect consumption outcome", err)
		}
		if scenario == "confirmed" {
			begin, consume, sent := slices.Index(queue.calls, "begin"), slices.Index(queue.calls, "consume"), slices.Index(queue.calls, "http")
			if begin < 0 || begin >= consume || consume >= sent || queue.final.State != Succeeded {
				t.Fatal("source write escaped durable attempt ordering")
			}
		} else if dispatch.calls != 0 || scenario == "ambiguous" && queue.final.State != Ambiguous {
			t.Fatal("unconfirmed label consumption reached dispatch")
		}
	}
}
