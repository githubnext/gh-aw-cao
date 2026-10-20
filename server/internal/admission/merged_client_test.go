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
	"testing"
)

// This optional integration test consumes the exact upstream parser without
// vendoring client code or requiring Node for ordinary server tests.
func TestMergedGhAWClientConformance(t *testing.T) {
	path := os.Getenv("GH_AW_ADMISSION_PROTOCOL_PATH")
	if path == "" {
		t.Skip("GH_AW_ADMISSION_PROTOCOL_PATH must point to gh-aw@be70cb4 admission_protocol.cjs with its error_codes.cjs sibling")
	}
	source, err := os.ReadFile(path) // #nosec G304 G703 -- explicit operator-selected fixture, verified against the pinned SHA-256 below.
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(source)
	if hex.EncodeToString(digest[:]) != "96ff134b1597e839702e5df389ab52a48fb5f35bcc5bada7a4bbc61751490ae4" {
		t.Fatal("client parser does not match the reviewed merged gh-aw revision")
	}
	node := func(operation string, input []byte) []byte {
		t.Helper()
		// #nosec G204 G702 -- explicit local integration fixture; parser bytes are pinned above, no shell or request input selects code.
		command := exec.CommandContext(t.Context(), "node", "-e", `
const fs = require("node:fs");
const protocol = require(process.argv[1]);
const input = fs.readFileSync(0, "utf8");
const result = process.argv[2] === "request"
  ? protocol.buildAdmissionIdentity(JSON.parse(input))
  : JSON.stringify(protocol.parseAdmissionDecision(input));
process.stdout.write(result);
`, path, operation)
		command.Stdin = bytes.NewReader(input)
		out, err := command.Output()
		if err != nil {
			t.Fatalf("merged client %s failed: %v", operation, err)
		}
		return out
	}
	fixture := newFixture(t)
	input := fixture.request
	env, err := json.Marshal(map[string]string{
		"GITHUB_REPOSITORY": input.Repo, "GH_AW_INFO_WORKFLOW_ID": input.WorkflowID,
		"GH_AW_ADMISSION_WORKFLOW_HASH": input.WorkflowHash, "GITHUB_RUN_ID": input.RunID,
		"GITHUB_RUN_ATTEMPT": input.RunAttempt, "GITHUB_REF": input.Ref,
		"GITHUB_EVENT_NAME": input.EventType, "GITHUB_ACTOR": input.Actor,
		"GITHUB_TRIGGERING_ACTOR": input.TriggeringActor,
	})
	if err != nil {
		t.Fatal(err)
	}
	body := node("request", env)
	token := fixture.token(t, fixture.claims)
	for _, allowances := range []Allowances{
		{Primary: 1},
		{Primary: 2147483647},
		{Primary: 1000, ThreatDetection: int32ptr(1)},
		{Primary: 1000, Evals: int32ptr(2147483647)},
		{Primary: 1000, ThreatDetection: int32ptr(2147483647), Evals: int32ptr(1)},
	} {
		service := &Service{Verifier: fixture.verifier,
			Policies:  policyFunc(func(context.Context, Identity) (Allowances, error) { return allowances, nil }),
			Decisions: decisionsFunc(func(_ context.Context, _ string, a *Allowances) (Allowances, error) { return *a, nil }),
		}
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "https://admission.example/api/admission", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cache-Control", "no-store")
		request.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		response := httptest.NewRecorder()
		service.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("merged request denied: %d", response.Code)
		}
		_ = node("response", response.Body.Bytes())
	}
}
