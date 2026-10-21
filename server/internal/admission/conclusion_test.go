package admission

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type conclusionPolicyFunc func(context.Context, Identity) error

func (f conclusionPolicyFunc) AuthorizeConclusion(ctx context.Context, i Identity) error {
	return f(ctx, i)
}

type conclusionSessionsFunc func(context.Context, Identity, ConclusionRequest) error

func (f conclusionSessionsFunc) RecordConclusion(ctx context.Context, i Identity, r ConclusionRequest) (ConclusionReceipt, error) {
	return ConclusionReceipt{AcceptedAt: time.Now().UTC()}, f(ctx, i, r)
}

func (conclusionSessionsFunc) CompleteConclusion(context.Context, Identity) error { return nil }

type concludedRunsFunc func(context.Context, Identity, ConclusionRequest, time.Time) error

func (f concludedRunsFunc) RecordConcludedRun(ctx context.Context, i Identity, r ConclusionRequest, at time.Time) error {
	return f(ctx, i, r, at)
}

type conclusionPersistence struct {
	record   func(context.Context, Identity, ConclusionRequest) (ConclusionReceipt, error)
	complete func(context.Context, Identity) error
}

func (p conclusionPersistence) RecordConclusion(ctx context.Context, identity Identity, input ConclusionRequest) (ConclusionReceipt, error) {
	return p.record(ctx, identity, input)
}

func (p conclusionPersistence) CompleteConclusion(ctx context.Context, identity Identity) error {
	return p.complete(ctx, identity)
}

func TestConclusionRequiresCanonicalPopulationAndRepairsPendingReceipt(t *testing.T) {
	f := newFixture(t)
	input := conclusionInput(f)
	body, _ := json.Marshal(input)
	receipt := ConclusionReceipt{AcceptedAt: time.Now().UTC().Truncate(time.Microsecond)}
	publications, completions := 0, 0
	publishErr, completionErr := ErrUnavailable, error(nil)
	service := &Service{
		Verifier:           f.verifier,
		ConclusionPolicies: conclusionPolicyFunc(func(context.Context, Identity) error { return nil }),
		Conclusions: conclusionPersistence{
			record: func(context.Context, Identity, ConclusionRequest) (ConclusionReceipt, error) { return receipt, nil },
			complete: func(context.Context, Identity) error {
				completions++
				if completionErr == nil {
					receipt.Populated = true
				}
				return completionErr
			},
		},
		ConclusionRuns: concludedRunsFunc(func(_ context.Context, _ Identity, received ConclusionRequest, at time.Time) error {
			publications++
			if !at.Equal(receipt.AcceptedAt) || received.Session != input.Session {
				t.Fatal("repair lost the first accepted snapshot")
			}
			return publishErr
		}),
	}
	call := func(expected int) {
		t.Helper()
		r := httptest.NewRequestWithContext(t.Context(), "POST", "/api/conclusion", bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "bearer "+f.token(t, f.claims))
		w := httptest.NewRecorder()
		service.Conclude(w, r)
		if w.Code != expected || w.Body.Len() != 0 {
			t.Fatalf("completion acknowledged before durable canonical publication: %d", w.Code)
		}
	}
	call(503)
	if completions != 0 {
		t.Fatal("failed publication marked receipt complete")
	}
	publishErr, completionErr = nil, ErrUnavailable
	call(503)
	if receipt.Populated {
		t.Fatal("failed completion marker acknowledged")
	}
	completionErr = nil
	call(204)
	call(204)
	if publications != 3 || completions != 2 {
		t.Fatal("completed receipt repopulated the canonical database")
	}
	service.ConclusionRuns = nil
	call(503)
}

func conclusionInput(f *fixture) ConclusionRequest {
	return ConclusionRequest{
		Request: f.request, Session: "{\"type\":\"session.format\",\"data\":{\"version\":1}}\n",
		SessionCompaction: SessionCompaction{Version: 1, IncludedEvents: 1},
		UsageArtifactIDs:  []string{"99999999999999999999", "8123"},
	}
}

func TestConclusionAuthenticationAndDurableAcceptance(t *testing.T) {
	f := newFixture(t)
	input := conclusionInput(f)
	token := f.token(t, f.claims)
	policies, records := 0, 0
	var policyErr, recordErr error
	service := &Service{
		Verifier:       f.verifier,
		ConclusionRuns: concludedRunsFunc(func(context.Context, Identity, ConclusionRequest, time.Time) error { return nil }),
		ConclusionPolicies: conclusionPolicyFunc(func(_ context.Context, i Identity) error {
			policies++
			if i.RepositoryID != "1001" || i.ActorID != "101" {
				t.Fatal("unverified completion identity")
			}
			return policyErr
		}),
		Conclusions: conclusionSessionsFunc(func(_ context.Context, i Identity, r ConclusionRequest) error {
			records++
			if !r.matches(i) || r.UsageArtifactIDs[0] != "99999999999999999999" {
				t.Fatal("lost invocation binding or artifact precision")
			}
			return recordErr
		}),
	}
	call := func(body []byte, credential, target, method string, modify func(*http.Request)) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequestWithContext(t.Context(), method, target, bytes.NewReader(body))
		r.Header.Set("Authorization", "bearer "+credential)
		r.Header.Set("Content-Type", "application/json")
		if modify != nil {
			modify(r)
		}
		w := httptest.NewRecorder()
		service.Conclude(w, r)
		if w.Body.Len() != 0 || len(w.Header()) != 1 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("completion response leaked: %d %v", w.Code, w.Header())
		}
		return w
	}
	body, _ := json.Marshal(input)
	if w := call(body, token, "/api/conclusion", "POST", nil); w.Code != 204 || records != 1 || policies != 1 {
		t.Fatalf("completion without admission not recorded: %d", w.Code)
	}
	for _, modify := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("Traceparent", strings.Repeat("x", 40<<10)) },
		func(r *http.Request) {
			r.Header.Add("Traceparent", "invalid")
			r.Header.Add("Traceparent", "duplicate")
		},
		func(r *http.Request) { r.Header.Set("Baggage", strings.Repeat("x", 40<<10)) },
	} {
		if w := call(body, token, "/api/conclusion", "POST", modify); w.Code != 204 {
			t.Fatal("trace context changed completion")
		}
	}
	for _, test := range []struct {
		name, target, method, credential string
		body                             []byte
		change                           func(*http.Request)
	}{
		{"method", "/api/conclusion", "GET", token, body, nil},
		{"query", "/api/conclusion?x=1", "POST", token, body, nil},
		{"empty query", "/api/conclusion?", "POST", token, body, nil},
		{"API token", "/api/conclusion", "POST", "ghs_synthetic", body, nil},
		{"missing token", "/api/conclusion", "POST", "", body, nil},
		{"forged repo", "/api/conclusion", "POST", token, bytes.Replace(body, []byte(`"repo":"acme/project"`), []byte(`"repo":"other/project"`), 1), nil},
		{"forged run", "/api/conclusion", "POST", token, bytes.Replace(body, []byte(`"run_id":"1234"`), []byte(`"run_id":"1235"`), 1), nil},
		{"forged attempt", "/api/conclusion", "POST", token, bytes.Replace(body, []byte(`"run_attempt":"2"`), []byte(`"run_attempt":"3"`), 1), nil},
		{"wrong type", "/api/conclusion", "POST", token, body, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }},
		{"duplicate auth", "/api/conclusion", "POST", token, body, func(r *http.Request) { r.Header.Add("Authorization", "bearer other") }},
		{"oversized header", "/api/conclusion", "POST", token, body, func(r *http.Request) { r.Header.Set("X-Large", strings.Repeat("x", 33<<10)) }},
		{"oversized body", "/api/conclusion", "POST", token, bytes.Repeat([]byte(" "), MaxConclusionBytes+1), nil},
		{"streamed oversized body", "/api/conclusion", "POST", token, bytes.Repeat([]byte(" "), MaxConclusionBytes+1), func(r *http.Request) { r.ContentLength = -1 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := policies
			if w := call(test.body, test.credential, test.target, test.method, test.change); w.Code != 403 || policies != before {
				t.Fatalf("invalid completion reached policy: %d", w.Code)
			}
		})
	}
	for _, failure := range []struct {
		policy, storage error
		status          int
	}{
		{ErrDenied, nil, 403}, {ErrUnavailable, nil, 503},
		{nil, ErrDenied, 403}, {nil, ErrUnavailable, 503},
	} {
		policyErr, recordErr = failure.policy, failure.storage
		before := records
		if w := call(body, token, "/api/conclusion", "POST", nil); w.Code != failure.status ||
			policyErr != nil && records != before {
			t.Fatalf("acknowledged without authorized durable record: %d", w.Code)
		}
	}
	policyErr, recordErr = nil, nil
	if w := call(body, token, "/api/conclusion", "POST", nil); w.Code != 204 {
		t.Fatal("dependency recovery lost completion")
	}
	// Completion and admission share the same signed claim and key verifier.
	f.claims["aud"] = "https://admission.example/api/conclusion"
	if w := call(body, f.token(t, f.claims), "/api/conclusion", "POST", nil); w.Code != 403 {
		t.Fatal("conclusion accepted an independently selected audience")
	}
}

func TestConclusionCompactEnvelope(t *testing.T) {
	f := newFixture(t)
	input := conclusionInput(f)
	body, _ := json.Marshal(input)
	for _, test := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"missing session", func(m map[string]any) { delete(m, "session") }},
		{"extra field", func(m map[string]any) { m["body"] = "PRIVATE" }},
		{"null session", func(m map[string]any) { m["session"] = nil }},
		{"array session", func(m map[string]any) { m["session"] = []string{} }},
		{"null IDs", func(m map[string]any) { m["usage_artifact_ids"] = nil }},
		{"duplicate IDs", func(m map[string]any) { m["usage_artifact_ids"] = []string{"1", "1"} }},
		{"too many IDs", func(m map[string]any) { m["usage_artifact_ids"] = []string{"1", "2", "3"} }},
		{"oversized ID", func(m map[string]any) { m["usage_artifact_ids"] = []string{strings.Repeat("9", 21)} }},
		{"numeric ID", func(m map[string]any) { m["usage_artifact_ids"] = []int{1} }},
		{"leading zero ID", func(m map[string]any) { m["usage_artifact_ids"] = []string{"01"} }},
		{"zero ID", func(m map[string]any) { m["usage_artifact_ids"] = []string{"0"} }},
		{"URL ID", func(m map[string]any) { m["usage_artifact_ids"] = []string{"https://attacker.example"} }},
		{"session budget", func(m map[string]any) { m["session"] = strings.Repeat(" ", MaxSessionBytes+1) }},
		{"count mismatch", func(m map[string]any) { m["session"] = "" }},
		{"no trailing LF", func(m map[string]any) { m["session"] = strings.TrimSuffix(input.Session, "\n") }},
		{"blank line", func(m map[string]any) { m["session"] = "\n" }},
		{"version", func(m map[string]any) { m["session_compaction"].(map[string]any)["version"] = 2 }},
		{"missing counter", func(m map[string]any) { delete(m["session_compaction"].(map[string]any), "omitted_events") }},
		{"null flag", func(m map[string]any) { m["session_compaction"].(map[string]any)["truncated"] = nil }},
		{"null counter", func(m map[string]any) { m["session_compaction"].(map[string]any)["omitted_events"] = nil }},
		{"case-folded counter", func(m map[string]any) {
			c := m["session_compaction"].(map[string]any)
			delete(c, "version")
			c["Version"] = 1
		}},
		{"extra counter", func(m map[string]any) { m["session_compaction"].(map[string]any)["extra"] = 0 }},
		{"negative counter", func(m map[string]any) { m["session_compaction"].(map[string]any)["omitted_events"] = -1 }},
		{"unsafe counter", func(m map[string]any) {
			m["session_compaction"].(map[string]any)["oversized_lines"] = int64(maxSafeInteger + 1)
		}},
		{"excess events", func(m map[string]any) {
			m["session"] = strings.Repeat(input.Session, MaxSessionEvents+1)
			m["session_compaction"].(map[string]any)["included_events"] = MaxSessionEvents + 1
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var values map[string]any
			if err := json.Unmarshal(body, &values); err != nil {
				t.Fatal(err)
			}
			test.edit(values)
			data, _ := json.Marshal(values)
			if _, err := decodeConclusion(data); !errors.Is(err, ErrDenied) {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
	for _, data := range [][]byte{
		bytes.Replace(body, []byte(`"repo":`), []byte(`"repo":"acme/project","repo":`), 1),
		bytes.Replace(body, []byte(`"version":1`), []byte(`"version":1,"\u0076ersion":1`), 1),
		bytes.Replace(body, []byte(`"session":`), []byte(`"\ud800":1,"session":`), 1),
		bytes.Replace(body, []byte(`"session":`), []byte("\"\xff\":1,\"session\":"), 1),
	} {
		if _, err := decodeConclusion(data); !errors.Is(err, ErrDenied) {
			t.Fatal("duplicate or invalid Unicode accepted")
		}
	}
	input.Session, input.SessionCompaction.IncludedEvents = "", 0
	input.UsageArtifactIDs = []string{}
	input.SessionCompaction.OmittedEvents, input.SessionCompaction.OversizedLines = maxSafeInteger, maxSafeInteger
	body, _ = json.Marshal(input)
	if _, err := decodeConclusion(body); err != nil {
		t.Fatal("empty compact/no artifact or safe counter boundary rejected")
	}
	input.Session = strings.Repeat("{\"type\":\"session.format\",\"data\":{}}\n", MaxSessionEvents)
	input.SessionCompaction.IncludedEvents = MaxSessionEvents
	body, _ = json.Marshal(input)
	if _, err := decodeConclusion(body); err != nil {
		t.Fatal("128-record boundary rejected")
	}
	padded := bytes.Clone(body)
	padded = append(padded, bytes.Repeat([]byte(" "), MaxConclusionBytes-len(body))...)
	if _, err := decodeConclusion(padded); err != nil {
		t.Fatal("64 KiB boundary rejected")
	}
	if _, err := decodeConclusion(append(padded, ' ')); !errors.Is(err, ErrDenied) {
		t.Fatal("64 KiB limit not enforced")
	}
}

func TestConclusionEnrollmentIndependentOfBudget(t *testing.T) {
	f := newFixture(t)
	i, err := f.verifier.Verify(t.Context(), f.token(t, f.claims))
	if err != nil {
		t.Fatal(err)
	}
	used := int64(10000)
	entry := Enrollment{
		Repository: i.Repository, RepositoryID: i.RepositoryID, OwnerID: i.OwnerID, Enabled: true,
		Subjects: []string{i.Subject}, Workflows: []Policy{{WorkflowRef: i.WorkflowRef, WorkflowSHA: i.WorkflowSHA,
			Events: []string{i.Event}, ActorIDs: []string{i.ActorID}, Allowances: Allowances{Primary: 1}}},
		Usage: Usage{Unit: "ai-credits", Used: &used, Limit: 1, ObservedAt: time.Now().Add(-time.Hour)},
	}
	file := FilePolicy{Path: filepath.Join(t.TempDir(), "snapshot.json")}
	save := func() {
		t.Helper()
		body, _ := json.Marshal(Snapshot{Version: 1, Repositories: []Enrollment{entry}})
		if err := os.WriteFile(file.Path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	save()
	if _, err := file.Evaluate(t.Context(), i); !errors.Is(err, ErrUnavailable) {
		t.Fatal("activation stopped enforcing accounting")
	}
	if err := file.AuthorizeConclusion(t.Context(), i); err != nil {
		t.Fatal("stale/exhausted spend suppressed completion")
	}
	for _, change := range []func(*Identity){
		func(i *Identity) { i.RepositoryID = "1002" },
		func(i *Identity) { i.OwnerID = "43" },
		func(i *Identity) { i.Subject = "other" },
		func(i *Identity) { i.WorkflowSHA = strings.Repeat("b", 40) },
		func(i *Identity) { i.WorkflowRef = "other" },
		func(i *Identity) { i.ActorID = "102" },
		func(i *Identity) { i.Event = "push" },
	} {
		other := i
		change(&other)
		if err := file.AuthorizeConclusion(t.Context(), other); !errors.Is(err, ErrDenied) {
			t.Fatal("completion widened enrollment")
		}
	}
	entry.Enabled = false
	save()
	if err := file.AuthorizeConclusion(t.Context(), i); !errors.Is(err, ErrDenied) {
		t.Fatal("disabled enrollment accepted")
	}
	if err := os.Remove(file.Path); err != nil {
		t.Fatal(err)
	}
	if err := file.AuthorizeConclusion(t.Context(), i); !errors.Is(err, ErrUnavailable) {
		t.Fatal("unavailable policy fabricated acceptance")
	}
}
