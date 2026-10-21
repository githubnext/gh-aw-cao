package admission

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPublishedConclusionClientConformance(t *testing.T) {
	directory := os.Getenv("GH_AW_CONCLUSION_RUNTIME_DIR")
	if directory == "" {
		t.Skip("GH_AW_CONCLUSION_RUNTIME_DIR must contain actions/setup/js from gh-aw@b2707604dd52732afa66ff7ae270bda96cf6c9fd")
	}
	for file, expected := range map[string]string{
		"conclusion_admission.cjs":    "b7c990ac22e371223cf4a3321ebbc8bd28b84a3323c14b4ea3ebc3505dd0ea97",
		"compact_unified_session.cjs": "f8e917db086f2e53347e25e8fb0b39708131bca9160c7633c58bff22a65f1b36",
		"admission_protocol.cjs":      "96ff134b1597e839702e5df389ab52a48fb5f35bcc5bada7a4bbc61751490ae4",
		"check_admission.cjs":         "2e6e217e7728635d4365601042fcb291bd3c3c0ece6baf4a711de2139e9305bc",
	} {
		// #nosec G304 G703 -- explicit test-only upstream fixture, checked against the published digest.
		data, err := os.ReadFile(filepath.Join(directory, file))
		if err != nil {
			t.Fatal(err)
		}
		actual := sha256.Sum256(data)
		if hex.EncodeToString(actual[:]) != expected {
			t.Fatalf("runtime file differs from the reviewed upstream pin: %s", file)
		}
	}
	f := newFixture(t)
	input := f.request
	// #nosec G101 -- Synthetic bootstrap for the local conformance fixture, never a live credential.
	env := map[string]string{
		"GH_AW_DEFAULT_ADMISSION_URL": "https://admission.example/api/admission",
		"GITHUB_REPOSITORY":           input.Repo, "GH_AW_INFO_WORKFLOW_ID": input.WorkflowID,
		"GH_AW_ADMISSION_WORKFLOW_HASH": input.WorkflowHash, "GITHUB_RUN_ID": input.RunID,
		"GITHUB_RUN_ATTEMPT": input.RunAttempt, "GITHUB_REF": input.Ref,
		"GITHUB_EVENT_NAME": input.EventType, "GITHUB_ACTOR": input.Actor,
		"GITHUB_TRIGGERING_ACTOR":        input.TriggeringActor,
		"ACTIONS_ID_TOKEN_REQUEST_URL":   "https://oidc.example/token",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-bootstrap",
		"GH_AW_USAGE_ARTIFACT_ID":        "99999999999999999999", "GH_AW_USAGE_ARTIFACT_RETRY_ID": "8123",
	}
	var mu sync.Mutex
	var recorded *ConclusionRequest
	var firstBody []byte
	requests := 0
	service := &Service{Verifier: f.verifier,
		ConclusionRuns:     concludedRunsFunc(func(context.Context, Identity, ConclusionRequest, time.Time) error { return nil }),
		ConclusionPolicies: conclusionPolicyFunc(func(context.Context, Identity) error { return nil }),
		Conclusions: conclusionSessionsFunc(func(_ context.Context, _ Identity, r ConclusionRequest) error {
			mu.Lock()
			defer mu.Unlock()
			encoded, _ := json.Marshal(r)
			if firstBody != nil && !bytes.Equal(encoded, firstBody) {
				t.Error("actual client retry mutated the accepted snapshot")
				return ErrDenied
			}
			firstBody, recorded = encoded, &r
			requests++
			return nil
		}),
	}
	server := httptest.NewServer(http.HandlerFunc(service.Conclude))
	defer server.Close()
	data, _ := json.Marshal(map[string]any{"env": env, "token": f.token(t, f.claims), "target": server.URL})
	// #nosec G204 G702 -- local Node conformance harness; executable module bytes are pinned above, never selected by a request.
	command := exec.CommandContext(t.Context(), "node", "-e", `
const fs = require("node:fs");
const { sendConclusion } = require(process.argv[1]);
const { compactUnifiedSession } = require(process.argv[2]);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const source = [
  { type: "session.format", data: { version: 1 } },
  { type: "workflow.info", data: { engineId: "copilot", awContext: { private: "must-not-forward" } } },
  { type: "usage.report", data: { provider: "github", aic: 1.5, usage: { totalTokens: 1 } } },
  { type: "assistant.message", data: { content: "must-not-forward" } },
  { type: "grader.result", data: { score: 0.5, run: { id: "one", passed: 1 } } }
];
const compact = compactUnifiedSession(source);
input.env.GH_AW_ADMISSION_COMPACT_SESSION = JSON.stringify({
  version: compact.version, session: compact.session, included_events: compact.includedEvents,
  omitted_events: compact.omittedEvents, oversized_lines: compact.oversizedLines,
  scan_truncated: compact.scanTruncated, truncated: compact.truncated
});
let posts = 0;
const fetchImpl = async (url, options) => {
  if (String(url).startsWith("https://oidc.example/token")) {
    if (new URL(url).searchParams.get("audience") !== input.env.GH_AW_DEFAULT_ADMISSION_URL)
      throw Error("wrong audience");
    return new Response(JSON.stringify({ value: input.token }), { status: 200 });
  }
  if (String(url) !== "https://admission.example/api/conclusion" || options.redirect !== "manual")
    throw Error("unexpected destination");
  const response = await fetch(input.target, options);
  if (++posts === 1) { await response.body?.cancel(); throw Error("lost acknowledgement"); }
  return response;
};
(async () => {
  for (const outage of ["ignore", "block"]) {
    input.env.GH_AW_DEFAULT_ADMISSION_ON_OUTAGE = outage;
    const result = await sendConclusion({ env: input.env, fetchImpl });
    if (result.result !== "delivered") throw Error("completion rejected");
  }
  if (posts !== 3) throw Error("retry or repeated delivery changed");
  process.stdout.write("actual-client-delivered");
})().catch(() => { process.exitCode = 1; });
`, filepath.Join(directory, "conclusion_admission.cjs"), filepath.Join(directory, "compact_unified_session.cjs"))
	command.Stdin = bytes.NewReader(data)
	out, err := command.Output()
	if err != nil || string(out) != "actual-client-delivered" {
		t.Fatalf("published callback conformance failed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if recorded == nil || requests != 3 || recorded.SessionCompaction.IncludedEvents != 4 ||
		recorded.SessionCompaction.OmittedEvents != 1 || strings.Contains(recorded.Session, "must-not-forward") ||
		len(recorded.UsageArtifactIDs) != 2 || recorded.UsageArtifactIDs[0] != "8123" ||
		recorded.UsageArtifactIDs[1] != "99999999999999999999" {
		t.Fatal("published compact projection, retry order or coverage was not preserved")
	}
}
