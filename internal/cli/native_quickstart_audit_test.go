package cli

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeQuickstartAuditMatchesProduction(t *testing.T) {
	node, root := nodeRuntime(t)
	t.Setenv("NODE_NO_WARNINGS", "1")
	raw := `{"schema_version":2,"kind":"workflow_runs","request":{"repository":"org/control"},"payload":[{"databaseId":10,"workflowName":"repo-assist","updatedAt":"2026-01-01T00:01:00Z"}]}`
	run := `{"schema_version":5,"kind":"run","run":{"organization":"org","repository":"control","workflow_name":"repo-assist","workflow_path":".github/workflows/repo-assist.lock.yml","run_id":10,"updated_at":"2026-01-01T00:01:00Z"}}`
	withSession := func(session string) string {
		return strings.TrimSuffix(run, "}}") + `,"cao_unified_session":` + session + "}}"
	}
	session := `{"version":1,"path":"aw_session.jsonl","events":[{"line":1,"source":"agent","type":"assistant.message","fields":{}}]}`
	token := `{"schema_version":5,"kind":"token_efficiency_observation","observation":{"optimizerRunId":10,"targetRepo":"org/control","workflowPath":"w.md","opportunityId":"op","interventionId":"in"}}`
	op := `{"schema_version":5,"kind":"operational_value","operational_value":{"repository":"org/control","timestamp":"2026-01-02T00:00:00Z","value_id":"example","value":1}}`
	safe := `{"schema_version":5,"kind":"safe_output_item","safe_output":{"run_id":10,"type":"create_issue","url":"https://github.com/org/control/issues/0"}}`
	lifecycle := `{"schema_version":5,"kind":"token_efficiency_lifecycle_observation","observation":{"optimizerRunId":10,"optimizerRunAttempt":1,"observedAt":"2026-01-02T00:00:00Z","targetRepo":"org/control","workflowPath":"w.md","opportunityId":"op","interventionId":"in","lifecycleObservationId":"life","previousInterventionState":"proposed","interventionState":"accepted","previousRecommendationDisposition":"unapplied","recommendationDisposition":"applied","evidenceState":"complete","optimizerWorkflowPath":"optimizer.md","optimizerWorkflowName":"Optimizer","safeOutputId":"out","safeOutputUrl":"https://github.com/org/control/issues/1","claimRunId":10,"claimRunAttempt":1,"actor":"operator","sourceProvenance":{}}}`
	period := `"window_start":"2026-01-01T00:00:00Z","window_end":"2026-01-02T00:00:00Z","measurement_kind":"interval","coverage_status":"complete"`
	periodOp := strings.Replace(op, `"value":1`, `"value":1,`+period, 1)
	type fixture struct{ Name, Input string }
	fixtures := []fixture{
		{"raw", raw},
		{"raw duplicates", raw + "\n" + raw},
		{"schema four", strings.Replace(raw, `"schema_version":2`, `"schema_version":4`, 1)},
		{"schema five", strings.Replace(raw, `"schema_version":2`, `"schema_version":5`, 1)},
		{"missing schema", strings.Replace(raw, `"schema_version":2,`, "", 1)},
		{"unsupported schema", strings.Replace(raw, `"schema_version":2`, `"schema_version":3`, 1)},
		{"string schema", strings.Replace(raw, `"schema_version":2`, `"schema_version":"2"`, 1)},
		{"array schema", strings.Replace(raw, `"schema_version":2`, `"schema_version":[2]`, 1)},
		{"object schema", strings.Replace(raw, `"schema_version":2`, `"schema_version":{}`, 1)},
		{"unknown kind", `{"schema_version":5,"kind":"future_kind","payload":null}` + "\n" + raw},
		{"unknown kind invalid schema", `{"schema_version":3,"kind":"future_kind"}`},
		{"invalid JSON", raw + "\nnot-json"},
		{"non-object JSON", "[]"},
		{"null JSON", "null"},
		{"empty kind", `{"schema_version":2,"kind":" "}`},
		{"missing payload", strings.Replace(raw, `"payload":`, `"ignored":`, 1)},
		{"invalid raw run", strings.Replace(raw, `"workflowName":"repo-assist"`, `"workflowName":""`, 1)},
		{"invalid raw timestamp", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `""`, 1)},
		{"date-only timestamp", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `"2026-01-01"`, 1)},
		{"normalized ISO day overflow", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `"2026-02-30T00:00:00Z"`, 1)},
		{"normalized ISO midnight", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `"2026-01-01T24:00:00Z"`, 1)},
		{"compact ISO offset", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `"2026-01-01T00:01:00+0100"`, 1)},
		{"invalid ISO offset", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `"2026-01-01T00:01:00+24:00"`, 1)},
		{"invalid ISO minute", strings.Replace(raw, `"2026-01-01T00:01:00Z"`, `"2026-01-01T00:61:00Z"`, 1)},
		{"string identifier", strings.Replace(raw, `"databaseId":10`, `"databaseId":"custom-id"`, 1)},
		{"large numeric identifier", strings.Replace(raw, `"databaseId":10`, `"databaseId":9007199254740993`, 1)},
		{"scientific numeric identifier", strings.Replace(raw, `"databaseId":10`, `"databaseId":1e23`, 1)},
		{"null identifier", strings.Replace(raw, `"databaseId":10`, `"databaseId":null`, 1)},
		{"invalid raw attempt", strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":0`, 1)},
		{"coerced raw attempt", strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":true`, 1)},
		{"array raw attempt", strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":[1]`, 1)},
		{"nested array raw attempt", strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":[[1]]`, 1)},
		{"invalid coerced array raw attempt", strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":[true]`, 1)},
		{"enriched only", run},
		{"enriched and raw", run + "\n" + raw},
		{"malformed enriched", raw + "\n" + `{"schema_version":5,"kind":"run","run":null}`},
		{"enriched missing owner", strings.Replace(run, `"organization":"org"`, `"organization":null`, 1)},
		{"run-context validation", strings.Replace(run, `"kind":"run"`, `"kind":"token_efficiency_run_context"`, 1)},
		{"valid unified session", raw + "\n" + withSession(session)},
		{"unsupported unified session", raw + "\n" + withSession(strings.Replace(session, `"version":1`, `"version":2`, 1))},
		{"malformed unified events", raw + "\n" + withSession(strings.Replace(session, `"fields":{}`, `"fields":[]`, 1))},
		{"malformed unified timestamp", raw + "\n" + withSession(strings.Replace(session, `"line":1`, `"line":1,"timestamp":null`, 1))},
		{"malformed unified path", raw + "\n" + withSession(strings.Replace(session, `"path":"aw_session.jsonl"`, `"path":null`, 1))},
		{"malformed unified metadata", raw + "\n" + withSession(strings.Replace(session, `"version":1`, `"version":1,"run":null`, 1))},
		{"malformed unified token summary", raw + "\n" + withSession(strings.Replace(session, `"version":1`, `"version":1,"run":{"token_usage_summary":null}`, 1))},
		{"new session replaces invalid old events", withSession(strings.Replace(session, `"fields":{}`, `"fields":[]`, 1)) + "\n" + withSession(session) + "\n" + raw},
		{"old-attempt malformed events ignored", withSession(strings.Replace(session, `"fields":{}`, `"fields":[]`, 1)) + "\n" + strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":2`, 1)},
		{"old-attempt unsupported session rejected", withSession(strings.Replace(session, `"version":1`, `"version":2`, 1)) + "\n" + strings.Replace(raw, `"databaseId":10`, `"databaseId":10,"attempt":2`, 1)},
		{"unmapped token observation", token + "\n" + raw},
		{"mapped token observation", run + "\n" + token + "\n" + raw},
		{"mapped token missing field", run + "\n" + strings.Replace(token, `"opportunityId":"op"`, `"opportunityId":null`, 1) + "\n" + raw},
		{"invalid token attempt", strings.Replace(token, `"optimizerRunId":10`, `"optimizerRunId":10,"runAttempt":0`, 1)},
		{"unmatched lifecycle", `{"schema_version":5,"kind":"token_efficiency_lifecycle_observation","observation":{"optimizerRunId":10,"optimizerRunAttempt":1}}` + "\n" + raw},
		{"mapped invalid lifecycle", run + "\n" + `{"schema_version":5,"kind":"token_efficiency_lifecycle_observation","observation":{"optimizerRunId":10,"optimizerRunAttempt":1}}` + "\n" + raw},
		{"valid mapped lifecycle", run + "\n" + lifecycle + "\n" + raw},
		{"ignored rate-limit payload", raw + "\n" + `{"schema_version":2,"kind":"github_api_rate_limit","rate_limit":null}`},
		{"operational value", raw + "\n" + op},
		{"invalid operational metric", raw + "\n" + strings.Replace(op, `"value":1`, `"value":null`, 1)},
		{"invalid operational digest", raw + "\n" + strings.Replace(op, `"value":1`, `"value":1,"evaluator_digest":"bad"`, 1)},
		{"invalid operational window", raw + "\n" + strings.Replace(op, `"value":1`, `"value":1,"window_start":"2026-01-01T00:00:00Z"`, 1)},
		{"invalid operational rollup", raw + "\n" + strings.Replace(op, `"value":1`, `"value":1,"rollup_numerator":1`, 1)},
		{"invalid operational cadence", raw + "\n" + strings.Replace(op, `"value":1`, `"value":1,"cadence_days":0`, 1)},
		{"valid operational period", raw + "\n" + periodOp},
		{"invalid operational interval", raw + "\n" + strings.Replace(periodOp, `"2026-01-02T00:00:00Z","measurement_kind"`, `"2026-01-01T00:00:00Z","measurement_kind"`, 1)},
		{"invalid operational timestamp offset", raw + "\n" + strings.Replace(periodOp, `"window_start":"2026-01-01T00:00:00Z"`, `"window_start":"2026-01-01T00:00:00+24:00"`, 1)},
		{"invalid operational timestamp precision", raw + "\n" + strings.Replace(strings.Replace(periodOp, `"window_start":"2026-01-01T00:00:00Z"`, `"window_start":"2026-01-01T00:00:00.0001Z"`, 1), `"window_end":"2026-01-02T00:00:00Z"`, `"window_end":"2026-01-01T00:00:00.0002Z"`, 1)},
		{"unavailable operational measurement", raw + "\n" + strings.Replace(periodOp, `"value":1`, `"value":null,"missing_reason":"no evidence","maturity_status":"unavailable"`, 1)},
		{"missing operational metric unavailable", raw + "\n" + strings.Replace(periodOp, `"value":1`, `"missing_reason":"no evidence","maturity_status":"unavailable"`, 1)},
		{"valid operational rollup", raw + "\n" + strings.Replace(op, `"value":1`, `"value":1,"rollup_numerator":0,"rollup_denominator":2`, 1)},
		{"empty operational rollup", raw + "\n" + strings.Replace(op, `"value":1`, `"value":1,"rollup_numerator":"","rollup_denominator":2`, 1)},
		{"operational error precedence", raw + "\n" + strings.Replace(op, `"value":1`, `"value":null,"evaluator_digest":"invalid"`, 1)},
		{"unmapped safe-output item", safe + "\n" + run + "\n" + raw},
		{"invalid mapped safe-output issue", run + "\n" + safe + "\n" + raw},
		{"safe-output empty target kind falls back to URL", run + "\n" + strings.Replace(safe, `"type":"create_issue"`, `"type":"create_issue","target":{"kind":""}`, 1) + "\n" + raw},
		{"safe-output temporary issue URL", run + "\n" + strings.Replace(safe, `"url":`, `"temporaryId":`, 1) + "\n" + raw},
		{"safe-output coerced issue URL", run + "\n" + strings.Replace(safe, `"url":"https://github.com/org/control/issues/0"`, `"url":["https://github.com/org/control/issues/0"]`, 1) + "\n" + raw},
		{"safe-output missing parent", raw + "\n" + strings.Replace(safe, `"run_id":10`, `"run_id":null`, 1)},
		{"explicit safe-output with session", withSession(session) + "\n" + safe + "\n" + raw},
		{"session safe-output overrides explicit", withSession(strings.Replace(session, `"version":1`, `"version":1,"run":{"safe_outputs":[]}`, 1)) + "\n" + safe + "\n" + raw},
		{"unrelated session issue URL ignored", withSession(strings.Replace(session, `"fields":{}`, `"fields":{"githubEntityType":"issue","correlationId":"https://github.com/org/control/issues/0"}`, 1)) + "\n" + raw},
		{"session issue URL validated", withSession(strings.Replace(strings.Replace(session, `"fields":{}`, `"fields":{"githubEntityType":"issue","correlationId":"https://github.com/org/control/issues/0"}`, 1), "assistant.message", "safe_output.result", 1)) + "\n" + raw},
	}
	for _, field := range []string{"observedAt", "targetRepo", "workflowPath", "opportunityId", "interventionId", "lifecycleObservationId", "previousInterventionState", "interventionState", "previousRecommendationDisposition", "recommendationDisposition", "evidenceState", "optimizerWorkflowPath", "optimizerWorkflowName", "safeOutputId", "safeOutputUrl", "claimRunId", "claimRunAttempt", "actor", "sourceProvenance"} {
		var value map[string]any
		if err := json.Unmarshal([]byte(lifecycle), &value); err != nil {
			t.Fatal(err)
		}
		nativeSetupMap(value["observation"])[field] = nil
		input, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, fixture{"lifecycle missing " + field, run + "\n" + string(input) + "\n" + raw})
	}
	input, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	program := `
import { readFileSync } from 'node:fs';
const { adaptCachedGhAwJsonlStream } = await import(process.argv[1]);
const { normalize } = await import(process.argv[2]);
const fixtures = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
for (const fixture of fixtures) {
  try {
    const adapted = await adaptCachedGhAwJsonlStream((async function* () { yield fixture.Input; })());
    normalize(adapted.observations);
    results.push({ count: adapted.rawRuns });
  } catch (error) { results.push({ error: error.message }); }
}
process.stdout.write(JSON.stringify(results));
`
	command := exec.Command(node, "--input-type=module", "-e", program,
		filepath.Join(root, "dashboard/site/src/data/adapters/gh-aw-logs.js"),
		filepath.Join(root, "dashboard/site/src/data/normalize/index.js"))
	command.Stdin = strings.NewReader(string(input))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("production audit oracle failed: %v: %s", err, output)
	}
	var expected []struct {
		Count int    `json:"count"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(output, &expected); err != nil {
		t.Fatal(err)
	}
	if len(expected) != len(fixtures) {
		t.Fatal("production audit oracle returned an incomplete result set")
	}
	for i, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			count, err := nativeQuickstartCountRuns(strings.NewReader(fixture.Input))
			errorText := ""
			if err != nil {
				errorText = err.Error()
			}
			if errorText != expected[i].Error || (err == nil && count != expected[i].Count) {
				t.Fatalf("native=(%d,%q), production=(%d,%q)", count, errorText, expected[i].Count, expected[i].Error)
			}
		})
	}
}
