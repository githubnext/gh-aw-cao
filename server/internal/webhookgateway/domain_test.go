package webhookgateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func domainFixture(t *testing.T) (Subscription, Event, Job, AuthorizationSnapshot) {
	t.Helper()
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	p := "/action"
	s := Subscription{SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "subscription-1",
		TenantID: "tenant-1", AppID: 10,
		Source: Source{ID: "route-1", Event: "custom_event", InstallationID: 20,
			RepositoryID: 30, OrganizationID: 40,
			IdentityConstraints: []IdentityConstraint{{Path: "/custom/id", Value: json.RawMessage("50")}}},
		Destination: Destination{Kind: "workflow_dispatch", InstallationID: 60, RepositoryID: 70,
			Workflow: "worker.yml", Ref: "main", Fields: []PayloadField{{Name: "action", Path: &p, Required: true}}},
		Delivery: DeliveryPolicy{TTLSeconds: 600, LeaseSeconds: 60, MaxAttempts: 3, RetryDelaySeconds: 2}}
	payload := []byte(`{"action":"edited","installation":{"id":20},"repository":{"id":30},"organization":{"id":40},"custom":{"id":50},"secret":"never-forward"}`)
	e, err := ParseEvent("delivery-1", "custom_event", payload, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	e.SourceID = "route-1"
	digest := MetadataDigest([]byte("trusted-metadata"))
	j, err := NewJob(now, "job-1", e, s, digest)
	if err != nil {
		t.Fatal(err)
	}
	j.QueueRevision = QueueRevision{Revision: 1, Digest: MetadataDigest([]byte("policy")), Enabled: true}
	a := AuthorizationSnapshot{Complete: true, CheckedAt: now, ExpiresAt: now.Add(20 * time.Second),
		JobID: j.ID, Fence: 1, Attempt: 1,
		SourceInstallationID: 20, SourceRepositoryID: 30, SourceOrganizationID: 40,
		ReceivingInstallationID: 20, DestinationInstallationID: 60, DestinationRepositoryID: 70,
		SourceAccessible: true, DestinationAccessible: true, SourcePermissionsOK: true, DispatchPermissionsOK: true,
		SourceVisibility: "private", DestinationVisibility: "private",
		CurrentRevision: Revision{RepositoryID: 70, CommitSHA: strings.Repeat("a", 40),
			MetadataPath: ".github/workflows/worker.json", Digest: digest, CompilerID: "gh-aw-v1"},
		Grant: AdminGrant{SubscriptionID: s.ID, Digest: digest, SourceInstallationID: 20,
			SourceRepositoryID: 30, SourceOrganizationID: 40, ReceivingInstallationID: 20,
			DestinationInstallationID: 60, DestinationRepositoryID: 70, DispatchKind: "workflow_dispatch",
			ExpiresAt: now.Add(time.Hour)}}
	return s, e, j, a
}

func TestDomainFilterMissingAndNegation(t *testing.T) {
	tests := []struct {
		name    string
		filter  string
		payload string
		want    Truth
	}{
		{"missing-ne", `{"op":"ne","path":"/missing","value":"x"}`, `{}`, Unknown},
		{"missing-not-eq", `{"op":"not","args":[{"op":"eq","path":"/missing","value":"x"}]}`, `{}`, Unknown},
		{"double-not-missing", `{"op":"not","args":[{"op":"not","args":[{"op":"eq","path":"/missing","value":"x"}]}]}`, `{}`, Unknown},
		{"null-exists", `{"op":"exists","path":"/x","value":true}`, `{"x":null}`, True},
		{"explicit-missing", `{"op":"exists","path":"/x","value":false}`, `{}`, True},
		{"typed-ne", `{"op":"ne","path":"/x","value":"1"}`, `{"x":1}`, Unknown},
		{"numeric-eq", `{"op":"eq","path":"/x","value":1e0}`, `{"x":1.00}`, True},
		{"large-ids-exact", `{"op":"eq","path":"/x","value":9007199254740993}`, `{"x":9007199254740992}`, False},
		{"in", `{"op":"in","path":"/x","value":[1,2]}`, `{"x":2}`, True},
		{"contains-array", `{"op":"contains","path":"/x","value":"a"}`, `{"x":["a","b"]}`, True},
		{"contains-string", `{"op":"contains","path":"/x","value":"bc"}`, `{"x":"abcd"}`, True},
		{"and-unknown", `{"op":"and","args":[{"op":"eq","path":"/x","value":1},{"op":"exists","path":"/y","value":true}]}`, `{"y":true}`, Unknown},
		{"or-true", `{"op":"or","args":[{"op":"eq","path":"/x","value":1},{"op":"exists","path":"/y","value":true}]}`, `{"y":true}`, True},
		{"escaped-pointer", `{"op":"eq","path":"/a~1b/~0","value":4}`, `{"a/b":{"~":4}}`, True},
		{"array-pointer", `{"op":"eq","path":"/x/0","value":4}`, `{"x":[4]}`, True},
		{"leading-zero-index", `{"op":"eq","path":"/x/00","value":4}`, `{"x":[4]}`, Unknown},
		{"huge-number", `{"op":"eq","path":"/x","value":1e999999999}`, `{"x":1}`, Unknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var f Filter
			if err := json.Unmarshal([]byte(tt.filter), &f); err != nil {
				t.Fatal(err)
			}
			got, err := EvaluateFilter(f, json.RawMessage(tt.payload), DefaultLimits())
			if err != nil || got != tt.want {
				t.Fatalf("got %s, %v; want %s", got, err, tt.want)
			}
		})
	}
}

func TestDomainRejectsInvalidSubscriptionAndJSON(t *testing.T) {
	s, _, _, _ := domainFixture(t)
	data, _ := json.Marshal(s)
	if _, err := ParseSubscription(data, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func([]byte) []byte{
		func(b []byte) []byte { return append(b, []byte(` {}`)...) },
		func(b []byte) []byte { return append([]byte(`{"unknown":1,`), b[1:]...) },
		func(b []byte) []byte { return append([]byte(`{"id":"duplicate",`), b[1:]...) },
		func(b []byte) []byte {
			return []byte(strings.Replace(string(b), "gh-aw.webhook-subscription/v1", "v2", 1))
		},
		func(b []byte) []byte {
			return []byte(strings.Replace(string(b), `"schemaVersion"`, `"SchemaVersion"`, 1))
		},
		func(b []byte) []byte {
			return []byte(strings.Replace(string(b), `"source":{`, `"source":{"unknown":1,`, 1))
		},
		func(b []byte) []byte {
			return []byte(strings.Replace(string(b), `"provider":"github"`, `"provider":"other"`, 1))
		},
		func(b []byte) []byte {
			return []byte(strings.Replace(string(b), `"provider":"github",`, "", 1))
		},
	} {
		if _, err := ParseSubscription(mutate(data), DefaultLimits()); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid schema accepted: %v", err)
		}
	}
	for _, raw := range []string{
		`{"op":"exec","path":"/x","value":"a"}`,
		`{"op":"not","args":[]}`,
		`{"op":"eq","path":"/a~2b","value":"a"}`,
		`{"op":"exists","path":"/x","value":1}`,
		`{"op":"eq","path":"/x","value":[]}`,
		`{"op":"in","path":"/x","value":[]}`,
		`{"op":"and","path":"/x","args":[{"op":"exists","path":"/x","value":true}]}`,
	} {
		var f Filter
		_ = json.Unmarshal([]byte(raw), &f)
		if _, err := EvaluateFilter(f, json.RawMessage(`{}`), DefaultLimits()); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid filter accepted: %s: %v", raw, err)
		}
	}
	f := Filter{Op: "exists", Path: "/x", Value: json.RawMessage("true")}
	for _, raw := range []string{`{"x":1,"x":2}`, `{"x":1} {}`, strings.Repeat("[", 40) + "0" + strings.Repeat("]", 40)} {
		if _, err := EvaluateFilter(f, json.RawMessage(raw), DefaultLimits()); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid payload accepted: %v", err)
		}
	}
	limits := DefaultLimits()
	limits.MaxEventBytes++
	if _, err := EvaluateFilter(f, json.RawMessage(`{}`), limits); !errors.Is(err, ErrInvalid) {
		t.Fatal("expanded hard ceiling accepted")
	}
	limits = DefaultLimits()
	limits.MaxFilterNodes = 1
	f = Filter{Op: "not", Args: []Filter{f}}
	if _, err := EvaluateFilter(f, json.RawMessage(`{}`), limits); !errors.Is(err, ErrInvalid) {
		t.Fatal("filter node ceiling ignored")
	}
}

func TestDomainGenericMatchTransformAndFreeze(t *testing.T) {
	s, e, j, _ := domainFixture(t)
	payload, err := BuildDispatchPayload(s, e, DefaultLimits())
	if err != nil || string(payload) != `{"inputs":{"action":"edited"},"ref":"main"}` {
		t.Fatalf("unexpected allowlist transform: %s %v", payload, err)
	}
	if strings.Contains(string(payload), "secret") {
		t.Fatal("undeclared payload escaped")
	}
	s.Source.IdentityConstraints[0].Value[0] = '9'
	e.Payload[0] = '['
	if string(j.Subscription.Source.IdentityConstraints[0].Value) != "50" || j.Payload[0] != '{' {
		t.Fatal("caller mutated frozen job")
	}
	s, e, _, _ = domainFixture(t)
	e.RepositoryID++
	if matches, _ := MatchSubscription(s, e, DefaultLimits()); matches {
		t.Fatal("repository identity mismatch accepted")
	}
	s, e, _, _ = domainFixture(t)
	s.Source.IdentityConstraints[0].Path = "/unknown"
	if matches, err := MatchSubscription(s, e, DefaultLimits()); err != nil || matches {
		t.Fatal("missing compiler identity matched")
	}
	s, e, _, _ = domainFixture(t)
	s.Destination.Kind, s.Destination.Workflow, s.Destination.Ref = "repository_dispatch", "", ""
	s.Destination.EventType = "generic-event"
	payload, err = BuildDispatchPayload(s, e, DefaultLimits())
	if err != nil || string(payload) != `{"client_payload":{"action":"edited"},"event_type":"generic-event"}` {
		t.Fatalf("repository transform: %s %v", payload, err)
	}
	s.Destination.Fields = make([]PayloadField, 11)
	if _, err := BuildDispatchPayload(s, e, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("property ceiling ignored")
	}
	s.Destination.Fields = []PayloadField{{Name: "_gateway", Literal: json.RawMessage(`"overwrite"`)}}
	if _, err := BuildDispatchPayload(s, e, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("reserved gateway metadata field accepted")
	}
	objectPath := "/installation"
	s.Destination.Fields = []PayloadField{{Name: "raw", Path: &objectPath}}
	if _, err := BuildDispatchPayload(s, e, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("whole webhook object copied instead of leaf allowlist")
	}
	rootPath := ""
	s.Destination.Fields[0].Path = &rootPath
	if _, err := BuildDispatchPayload(s, e, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("whole payload root copied")
	}
}

func TestDomainAuthorizationFailClosed(t *testing.T) {
	_, _, j, snapshot := domainFixture(t)
	now := j.CreatedAt
	var err error
	j, err = ClaimJob(now, j, j.Version, 1, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	if d, err := ValidateAuthorization(now, j, snapshot); err != nil || !d.Allowed {
		t.Fatalf("valid auth denied: %+v %v", d, err)
	}
	cases := []struct {
		name   string
		mutate func(*AuthorizationSnapshot)
		cancel bool
	}{
		{"incomplete", func(a *AuthorizationSnapshot) { a.Complete = false }, false},
		{"expired", func(a *AuthorizationSnapshot) { a.ExpiresAt = now }, false},
		{"future", func(a *AuthorizationSnapshot) { a.CheckedAt = now.Add(time.Second) }, false},
		{"stale-window", func(a *AuthorizationSnapshot) { a.ExpiresAt = now.Add(time.Hour) }, false},
		{"claim-fence", func(a *AuthorizationSnapshot) { a.Fence++ }, false},
		{"attempt", func(a *AuthorizationSnapshot) { a.Attempt++ }, false},
		{"job", func(a *AuthorizationSnapshot) { a.JobID = "different" }, false},
		{"revision", func(a *AuthorizationSnapshot) { a.CurrentRevision.Digest = MetadataDigest([]byte("new")) }, true},
		{"grant-digest", func(a *AuthorizationSnapshot) { a.Grant.Digest = MetadataDigest([]byte("other")) }, true},
		{"grant-scope", func(a *AuthorizationSnapshot) { a.Grant.SourceRepositoryID++ }, true},
		{"grant-project", func(a *AuthorizationSnapshot) { a.Grant.ProjectIDs = []string{"PVT_other"} }, true},
		{"grant-revoked", func(a *AuthorizationSnapshot) { a.Grant.Revoked = true }, true},
		{"receiving-installation", func(a *AuthorizationSnapshot) { a.ReceivingInstallationID++ }, true},
		{"source-access", func(a *AuthorizationSnapshot) { a.SourceAccessible = false }, true},
		{"destination-access", func(a *AuthorizationSnapshot) { a.DestinationAccessible = false }, true},
		{"dispatch-permissions", func(a *AuthorizationSnapshot) { a.DispatchPermissionsOK = false }, true},
		{"visibility", func(a *AuthorizationSnapshot) { a.DestinationVisibility = "public" }, true},
		{"unknown-visibility", func(a *AuthorizationSnapshot) { a.SourceVisibility = "" }, false},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			a := snapshot
			tt.mutate(&a)
			d, err := ValidateAuthorization(now, j, a)
			if err != nil || d.Allowed || d.Cancel != tt.cancel {
				t.Fatalf("got %+v %v, want cancel %v", d, err, tt.cancel)
			}
		})
	}
	a := snapshot
	a.DestinationVisibility = "public"
	a.Grant.AllowVisibilityTransfer = true
	if d, err := ValidateAuthorization(now, j, a); err != nil || !d.Allowed {
		t.Fatalf("explicit visibility grant denied: %+v %v", d, err)
	}
	auth := Authorization{Revision: j.QueueRevision, ApprovedSubscriptionDigest: j.SubscriptionDigest, Snapshot: snapshot}
	if err := ValidateDispatchAuthorization(j, auth, now); err != nil {
		t.Fatal(err)
	}
	auth.Revision.Revision++
	if err := ValidateDispatchAuthorization(j, auth, now); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("changed queue revision accepted")
	}
}

func TestDomainStateMachineFencingAndRecovery(t *testing.T) {
	_, _, original, _ := domainFixture(t)
	now := original.CreatedAt
	claimed, err := ClaimJob(now, original, original.Version, 1, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ClaimJob(now, original, original.Version+1, 1, "owner"); !errors.Is(err, ErrConflict) {
		t.Fatal("stale version accepted")
	}
	if _, err := StartDispatch(now, claimed, 2, "owner", AuthorizationDecision{Allowed: true}); err == nil {
		t.Fatal("stale fence accepted")
	}
	recovered, err := RecoverJob(claimed.LeaseUntil, claimed)
	if err != nil || recovered.State != Ready || recovered.Fence <= claimed.Fence {
		t.Fatalf("claim not recovered: %+v %v", recovered, err)
	}
	dispatching, err := StartDispatch(now, claimed, 1, "owner", AuthorizationDecision{Allowed: true})
	if err != nil || dispatching.Attempt != 1 {
		t.Fatalf("dispatch failed: %+v %v", dispatching, err)
	}
	ambiguous, err := RecoverJob(dispatching.LeaseUntil, dispatching)
	if err != nil || ambiguous.State != Ambiguous {
		t.Fatalf("uncertain dispatch recovered unsafely: %+v %v", ambiguous, err)
	}
	if _, err := CancelJob(now, dispatching, dispatching.Version); err == nil {
		t.Fatal("in-flight dispatch cancelled")
	}
	if _, err := FinishDispatch(dispatching.LeaseUntil, dispatching, 1, "owner", DispatchResult{Outcome: "succeeded"}); err == nil {
		t.Fatal("expired owner accepted")
	}
	retry, err := FinishDispatch(now, dispatching, 1, "owner",
		DispatchResult{Outcome: "retry", Reason: "rate-limited", RetryAt: now.Add(10 * time.Second)})
	if err != nil || retry.State != Ready || retry.NotBefore != now.Add(10*time.Second) {
		t.Fatalf("known nonacceptance retry failed: %+v %v", retry, err)
	}
	if _, err := FinishDispatch(now, dispatching, 1, "owner", DispatchResult{Outcome: "retry", Reason: "unknown-network"}); err == nil {
		t.Fatal("ambiguous replay permitted")
	}
	for _, state := range []JobState{Succeeded, Expired, Rejected, Cancelled, Failed, Ambiguous} {
		j := original
		j.State = state
		if _, err := ClaimJob(now, j, j.Version, 1, "owner"); err == nil {
			t.Fatalf("terminal %s revived", state)
		}
		if _, err := RecoverJob(now, j); err == nil {
			t.Fatalf("terminal %s recovered", state)
		}
	}
}

func TestDomainResponseClassifier(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		response DispatchResponse
		outcome  string
		reason   string
	}{
		{"accepted", DispatchResponse{StatusCode: 204}, "succeeded", "dispatch-accepted"},
		{"workflow-run-details", DispatchResponse{StatusCode: 200,
			Body: json.RawMessage(`{"workflow_run_id":123,"run_url":"https://api.github.com/repos/a/b/actions/runs/123","html_url":"https://github.com/a/b/actions/runs/123"}`)}, "succeeded", "dispatch-accepted"},
		{"permission-obscured-404", DispatchResponse{StatusCode: 404, Body: json.RawMessage(`{"message":"Not Found"}`)}, "rejected", "permission-or-not-found"},
		{"trigger-missing", DispatchResponse{StatusCode: 422, Body: json.RawMessage(`{"message":"Workflow does not have 'workflow_dispatch' trigger"}`)}, "rejected", "dispatch-trigger-missing"},
		{"disabled", DispatchResponse{StatusCode: 403, Body: json.RawMessage(`{"message":"Workflow is disabled"}`)}, "rejected", "workflow-unavailable"},
		{"removed", DispatchResponse{StatusCode: 410, Body: json.RawMessage(`{"message":"Workflow has been deleted"}`)}, "rejected", "workflow-unavailable"},
		{"rate", DispatchResponse{StatusCode: 429, RetryAfter: "12"}, "retry", "rate-limited"},
		{"secondary", DispatchResponse{StatusCode: 403, Body: json.RawMessage(`{"message":"You have exceeded a secondary rate limit"}`)}, "retry", "rate-limited"},
		{"permissions-not-rate", DispatchResponse{StatusCode: 403, Body: json.RawMessage(`{"message":"Resource not accessible by integration"}`)}, "rejected", "dispatch-rejected"},
		{"malformed-rate-body", DispatchResponse{StatusCode: 403, Body: json.RawMessage(`{"message":"API rate limit exceeded"} trailing`)}, "rejected", "dispatch-rejected"},
		{"duplicate-rate-body", DispatchResponse{StatusCode: 403, Body: json.RawMessage(`{"message":"other","message":"API rate limit exceeded"}`)}, "rejected", "dispatch-rejected"},
		{"500", DispatchResponse{StatusCode: 500}, "ambiguous", "dispatch-completion-unknown"},
		{"timeout", DispatchResponse{TransportOutcome: "unknown"}, "ambiguous", "transport-completion-unknown"},
		{"not-sent", DispatchResponse{TransportOutcome: "not-sent"}, "retry", "not-sent"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := tt.response
			r.Kind = "workflow_dispatch"
			if r.TransportOutcome == "" {
				r.TransportOutcome = "response"
			}
			result, err := ClassifyDispatchResponse(now, r)
			if err != nil || result.Outcome != tt.outcome || result.Reason != tt.reason {
				t.Fatalf("got %+v %v", result, err)
			}
			if tt.name == "rate" && result.RetryAt != now.Add(12*time.Second) {
				t.Fatal("Retry-After ignored")
			}
		})
	}
	date := now.Add(15 * time.Second)
	r := DispatchResponse{Kind: "repository_dispatch", StatusCode: 429, TransportOutcome: "response",
		RetryAfter: date.Format(http.TimeFormat)}
	result, err := ClassifyDispatchResponse(now, r)
	if err != nil || !result.RetryAt.Equal(date) {
		t.Fatalf("HTTP-date retry ignored: %+v %v", result, err)
	}
}

func domainQueueOptions() QueueOptions {
	rate := RateBudget{Capacity: 5, Period: time.Minute}
	return QueueOptions{MaxRows: 100, MaxBytes: 1 << 20,
		MaxTenantRows: 50, MaxTenantBytes: 1 << 19, MaxSourceRows: 50, MaxSourceBytes: 1 << 19,
		MaxDestinationRows: 50, MaxDestinationBytes: 1 << 19, MaxPayloadBytes: 1 << 18,
		MaxBatch: 10, MaxConcurrency: 2, MaxAge: time.Hour, DedupWindow: time.Hour,
		TerminalRetention: 2 * time.Hour, LeaseDuration: time.Minute,
		Rates: RateBudgets{Global: rate, App: rate, Tenant: rate, Destination: rate, Workflow: rate}}
}

func TestDomainAdmissionValidation(t *testing.T) {
	_, _, j, _ := domainFixture(t)
	o := domainQueueOptions()
	a := Admission{Revision: j.QueueRevision, DeliveryID: j.DeliveryID,
		DeliveryDigest: MetadataDigest(j.Payload), Jobs: []Job{j}}
	if err := ValidateAdmission(a, o); err != nil {
		t.Fatal(err)
	}
	a.Jobs = nil
	if err := ValidateAdmission(a, o); err != nil {
		t.Fatal("empty delivery must retain a receipt", err)
	}
	a.Jobs = []Job{j, j}
	if err := ValidateAdmission(a, o); !errors.Is(err, ErrInvalid) {
		t.Fatal("duplicate subscription jobs accepted")
	}
	a.Jobs = []Job{j}
	a.DeliveryDigest = "not-a-digest"
	if err := ValidateAdmission(a, o); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid original-delivery digest accepted")
	}
	o.DedupWindow = o.MaxAge - time.Second
	if err := ValidateQueueOptions(o); !errors.Is(err, ErrInvalid) {
		t.Fatal("dedup window shorter than lifetime accepted")
	}
	o = domainQueueOptions()
	o.TerminalRetention = o.DedupWindow - time.Second
	if err := ValidateQueueOptions(o); !errors.Is(err, ErrInvalid) {
		t.Fatal("terminal retention shorter than dedup accepted")
	}
}

func TestDomainDispatchByteCeiling(t *testing.T) {
	s, e, _, _ := domainFixture(t)
	s.Destination.Fields = []PayloadField{{Name: "literal",
		Literal: json.RawMessage(`"` + strings.Repeat("a", 65536) + `"`)}}
	if _, err := BuildDispatchPayload(s, e, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("oversized complete dispatch body accepted")
	}
	s.Destination.Fields[0].Literal = json.RawMessage(`"` + strings.Repeat("a", 64000) + `"`)
	body, err := BuildDispatchPayload(s, e, DefaultLimits())
	if err != nil || len(body) > 65536 {
		t.Fatal("valid near-ceiling dispatch rejected", err)
	}
}

func TestDomainProjectNodeIDsRequireExactGenericConstraint(t *testing.T) {
	s, e, j, snapshot := domainFixture(t)
	s.Source.ProjectIDs = []string{"PVT_kwDO_approved"}
	s.Source.IdentityConstraints = []IdentityConstraint{{
		Path: "/projects_v2_item/project_node_id", Value: json.RawMessage(`"PVT_kwDO_approved"`),
	}}
	e.Payload = json.RawMessage(`{"action":"edited","installation":{"id":20},"repository":{"id":30},"organization":{"id":40},"projects_v2_item":{"project_node_id":"PVT_kwDO_approved","node_id":"PVTI_item_not_project"}}`)
	if matches, err := MatchSubscription(s, e, DefaultLimits()); err != nil || !matches {
		t.Fatalf("GraphQL node identity did not match: %v %v", matches, err)
	}
	j, err := NewJob(j.CreatedAt, j.ID, e, s, j.SubscriptionDigest)
	if err != nil {
		t.Fatal(err)
	}
	j, err = ClaimJob(j.CreatedAt, j, j.Version, 1, "owner")
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Grant.ProjectIDs = []string{"PVT_kwDO_approved"}
	if decision, err := ValidateAuthorization(j.CreatedAt, j, snapshot); err != nil || !decision.Allowed {
		t.Fatalf("exact string grant denied: %+v %v", decision, err)
	}
	snapshot.Grant.ProjectIDs = []string{"PVTI_item_not_project"}
	if decision, err := ValidateAuthorization(j.CreatedAt, j, snapshot); err != nil || decision.Allowed || !decision.Cancel {
		t.Fatalf("item node incorrectly authorized project: %+v %v", decision, err)
	}
	s.Source.IdentityConstraints = nil
	if err := ValidateSubscription(s, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("unconstrained project scope accepted")
	}
	s.Source.ProjectIDs = []string{"PVT_kwDO_approved", "MDc6UHJvamVjdDExMQ=="}
	s.Source.IdentityConstraints = []IdentityConstraint{{
		Path: "/projects_v2_item/project_node_id", Value: json.RawMessage(`["MDc6UHJvamVjdDExMQ==","PVT_kwDO_approved"]`),
	}}
	if matches, err := MatchSubscription(s, e, DefaultLimits()); err != nil || !matches {
		t.Fatalf("explicit allowed set rejected: %v %v", matches, err)
	}
	s.Source.IdentityConstraints[0].Value = json.RawMessage(`["MDc6UHJvamVjdDExMQ==","PVT_kwDO_approved","PVT_unapproved"]`)
	if err := ValidateSubscription(s, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("constraint includes unapproved project")
	}
	s.Source.IdentityConstraints[0].Value = json.RawMessage(`["MDc6UHJvamVjdDExMQ==","PVT_kwDO_approved",123]`)
	if err := ValidateSubscription(s, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("mixed constraint widens project scope")
	}
	s.Source.ProjectIDs = []string{"PVT_kwDO_approved", "PVT_kwDO_approved"}
	if err := ValidateSubscription(s, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("duplicate project node IDs accepted")
	}
}
