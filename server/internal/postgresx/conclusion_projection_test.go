package postgresx

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

func TestCompactConclusionMatchesCanonicalSessionUsage(t *testing.T) {
	node, err := exec.LookPath("node")
	if errors.Is(err, exec.ErrNotFound) {
		t.Skip("Node is required for canonical session-adapter parity")
	}
	if err != nil {
		t.Fatal(err)
	}
	identity := admissionIdentity()
	for _, session := range []string{
		canonicalConclusionInput(identity).Session,
		`{"type":"session.result","data":{"usage":{"inputTokens":100,"outputTokens":7,"cacheReadInputTokens":0}}}` + "\n" +
			`{"type":"usage.report","data":{"aic":0,"usage":{"inputTokens":3}}}` + "\n" +
			`{"type":"firewall.token_usage","data":{"totalAic":9,"usage":{"outputTokens":4}}}` + "\n" +
			`{"type":"session.result","data":{"usage":{"inputTokens":999,"outputTokens":999}}}` + "\n",
		`{"type":"usage.report","data":{"aic":1},"provenance":{"phase":""}}` + "\n" +
			`{"type":"usage.report","data":{"aic":2}}` + "\n" +
			`{"type":"usage.report","data":{"aic":4,"totalAic":7}}` + "\n" +
			`{"type":"usage.report","data":{"aic":2}}` + "\n",
		`{"type":"session.result","data":{"usage":{"inputTokens":100,"outputTokens":7}}}` + "\n" +
			`{"type":"session.result","data":{"usage":{"totalTokens":107}}}` + "\n" +
			`{"type":"session.result","data":{"status":"success"}}` + "\n",
	} {
		run, err := invocationRun(identity)
		if err != nil {
			t.Fatal(err)
		}
		projected, err := projectConclusion(identity, admission.ConclusionRequest{Session: session}, run, time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
		cwd, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		module := (&url.URL{Scheme: "file", Path: filepath.Join(cwd, "../../..", "dashboard/site/src/data/adapters/unified-session-telemetry.js")}).String()
		// #nosec G204 G702 -- repository-owned reference normalizer, not request-selected executable code.
		command := exec.CommandContext(t.Context(), node, "--input-type=module", "-e", `
import fs from "node:fs";
const { sessionRunMetadata } = await import(process.argv[1]);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const records = input.session.trimEnd().split("\n").map((line, index) => ({ record: JSON.parse(line), line: index + 1 }));
process.stdout.write(JSON.stringify(sessionRunMetadata(records, { runId: input.runId, attempt: 2 })));
`, module)
		data, _ := json.Marshal(map[string]string{"session": session, "runId": identity.RunID})
		command.Stdin = bytes.NewReader(data)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("canonical session reference failed: %v %s", err, output)
		}
		var reference struct {
			Summary map[string]json.Number `json:"token_usage_summary"`
		}
		if err := json.Unmarshal(output, &reference); err != nil {
			t.Fatal(err)
		}
		for source, target := range map[string]string{
			"total_input_tokens": "inputTokens", "total_output_tokens": "outputTokens",
			"total_cache_read_tokens": "cacheReadTokens", "total_cache_write_tokens": "cacheWriteTokens",
			"total_reasoning_tokens": "reasoningTokens", "total_aic": "aicTotal",
		} {
			expected, present := reference.Summary[source]
			actual, exists := projected.run[target]
			if present != exists || present && fmt.Sprint(actual) != string(expected) {
				t.Fatalf("canonical session accounting mismatch %s: got %v, expected %s", target, actual, expected)
			}
		}
	}
}

func TestCompactConclusionScopedEvidenceAndNumericBounds(t *testing.T) {
	identity := admissionIdentity()
	input := canonicalConclusionInput(identity)
	input.Session += strings.Join([]string{
		`{"type":"workflow.info","data":{"runId":"other","model":"foreign-model"}}`,
		`{"type":"grader.result","data":{"id":"foreign","run":{"id":"other","attempt":2},"value":1}}`,
		`{"type":"grader.result","data":{"id":"negative","value":-0.5,"threshold":-1}}`,
	}, "\n") + "\n"
	run, _ := invocationRun(identity)
	projected, err := projectConclusion(identity, input, run, time.Now().UTC())
	if err != nil || projected.run["modelId"] != "model-1" || len(projected.observations) != 2 ||
		projected.observations[1]["value"] != -0.5 || projected.graders[1]["threshold"] != float64(-1) {
		t.Fatalf("scoped/negative evidence projection changed: %+v %v", projected, err)
	}
	input.Session = `{"type":"usage.report","data":{"usage":{"inputTokens":9007199254740991}}}` + "\n" +
		`{"type":"usage.report","data":{"usage":{"inputTokens":1}}}` + "\n" +
		`{"type":"usage.report","data":{"usage":{"inputTokens":1}},"provenance":{"phase":"evals"}}` + "\n"
	run, _ = invocationRun(identity)
	projected, err = projectConclusion(identity, input, run, time.Now().UTC())
	if err != nil || projected.run["inputTokens"] != nil {
		t.Fatal("overflowed aggregate became a partial success-shaped total")
	}
}
