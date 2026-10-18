package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeValidationMissingPolicyReportAndExitCode(t *testing.T) {
	nativeManagementDirectory(t)
	calls := 0
	gh := func(context.Context, ...string) (string, string, error) {
		calls++
		return "", "", nil
	}
	report := nativeValidateRepository(context.Background(), gh, nativeValidationExec, false)
	if report.ExitCode != 1 || report.Summary["errors"] != 1 || report.Findings[0].ID != "missing-cao-policy" || calls != 0 {
		t.Fatalf("missing policy report = %#v; calls = %d", report, calls)
	}
	text := nativeFormatValidation(report)
	if !strings.Contains(text, "✗ Policy") || !strings.HasSuffix(text, "1 error, 0 warnings") {
		t.Fatalf("formatted report = %s", text)
	}
	cmd, output := nativeManagementCommand()
	cmd.Flags().Bool("json", true, "")
	cmd.Flags().Bool("strict-warnings", false, "")
	err := nativeValidate(cmd, gh)
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != 1 || !strings.Contains(output.String(), `"validatorVersion": "1"`) || strings.Contains(output.String(), `"command"`) {
		t.Fatalf("status/output = %v\n%s", err, output)
	}
}

func TestNativeValidationCompilationIsolatedAndStrict(t *testing.T) {
	nativeManagementDirectory(t)
	writeTestFile(t, ".github/workflows/example.md", "---\non: workflow_dispatch\n---\n")
	lock := "# gh-aw-metadata: {\"compiler_version\":\"v0.92.0\"}\nchecked in\n"
	writeTestFile(t, ".github/workflows/example.lock.yml", lock)
	writeTestFile(t, ".github/workflows/orphan.lock.yml", "# retired\n")
	writeTestFile(t, ".github/aw/actions-lock.json", "{}")
	var calls [][]string
	run := func(_ context.Context, directory, program string, args ...string) (string, error) {
		if !strings.HasPrefix(filepath.Base(directory), ".cao-validate-") {
			t.Fatalf("compiler is not isolated: %s", directory)
		}
		calls = append(calls, append([]string{program}, args...))
		if program == "gh" {
			if !reflect.DeepEqual(args, []string{"aw", "compile", "--strict", "--validate", "--show-all", "--no-check-update", "--schedule-seed", catalogRepository, "--dir", filepath.Join(".github", "workflows")}) {
				t.Fatalf("compiler args = %q", args)
			}
			if _, err := os.Stat(filepath.Join(directory, ".github", "aw", "actions-lock.json")); err != nil {
				t.Fatal("actions lock was not copied")
			}
			if err := os.WriteFile(filepath.Join(directory, ".github/workflows/example.lock.yml"), []byte(lock+"regenerated\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return "", nil
	}
	findings, err := nativeCompileCompare(context.Background(), run, "v0.92.0")
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, finding := range findings {
		ids = append(ids, finding.ID)
	}
	if !reflect.DeepEqual(ids, []string{"stale-generated-workflow", "orphaned-generated-workflow"}) || len(calls) != 4 {
		t.Fatalf("findings/calls = %q, %q", ids, calls)
	}
	original, err := os.ReadFile(".github/workflows/example.lock.yml")
	if err != nil || string(original) != lock {
		t.Fatal("validation modified checked-in generated workflow")
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".cao-validate-") {
			t.Fatal("isolated compiler checkout was not removed")
		}
	}
}

func TestNativeValidationCompilerFailureClassification(t *testing.T) {
	nativeManagementDirectory(t)
	writeTestFile(t, ".github/workflows/example.md", "---\n---\n")
	run := func(_ context.Context, _, program string, _ ...string) (string, error) {
		if program == "gh" {
			return "invalid safe-output configuration", errors.New("compiler failed")
		}
		return "", nil
	}
	findings, err := nativeCompileCompare(context.Background(), run, "v1.0.0")
	if err != nil || len(findings) != 1 || findings[0].ID != "invalid-safe-output" {
		t.Fatalf("classification = %#v, %v", findings, err)
	}
}

func TestNativeValidationReportStrictWarningsAndEnablement(t *testing.T) {
	for _, strict := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal", true: "strict"}[strict], func(t *testing.T) {
			nativeManagementDirectory(t)
			writeTestFile(t, policyPath, `{"version":1,"gh-aw-version":"v0.92.0","control-plane":{}}`)
			gh := func(_ context.Context, args ...string) (string, string, error) {
				switch strings.Join(args[:2], " ") {
				case "aw version":
					return "v0.92.0", "", nil
				case "aw doctor":
					return "", "unauthenticated", errors.New("doctor failed")
				case "workflow list":
					return "[]", "", nil
				default:
					t.Fatalf("unexpected validation call %q", args)
					return "", "", nil
				}
			}
			run := func(context.Context, string, string, ...string) (string, error) { return "", nil }
			report := nativeValidateRepository(context.Background(), gh, run, strict)
			expected := 0
			if strict {
				expected = 1
			}
			if report.ExitCode != expected || report.Summary["warnings"] != 1 || report.Summary["errors"] != 0 {
				t.Fatalf("report = %#v", report)
			}
		})
	}
	installed := []nativeInstalledDeclaration{{name: "one", file: "one/cao.json", declaration: &campaignDeclaration{Campaign: "one", Orchestrator: "one", Workers: []campaignWorker{{Name: "worker", Workflow: "one-worker"}}}}}
	gh := func(context.Context, ...string) (string, string, error) {
		return `[{"path":".github/workflows/one.lock.yml","state":"disabled_manually"},{"path":".github/workflows/one-worker.lock.yml","state":"active"}]`, "", nil
	}
	findings := nativeValidateEnablement(context.Background(), gh, installed)
	if len(findings) != 1 || findings[0].ID != "campaign-orchestrator-paused" || findings[0].Severity != "note" {
		t.Fatalf("intentional pause findings = %#v", findings)
	}
}

func TestNativeValidationSecurityAndPolicyResolution(t *testing.T) {
	nativeManagementDirectory(t)
	writeTestFile(t, "one/cao.json", `{"campaign":"one","orchestrator":"one","workers":{"worker":"one-worker"}}`)
	writeTestFile(t, ".github/workflows/one.md", "---\nsafe-outputs:\n  create-issue:\ninputs:\n  password:\n---\n")
	writeTestFile(t, ".github/workflows/one-worker.md", "---\nsafe-outputs:\n  dispatch-workflow:\n---\n")
	writeTestFile(t, ".github/workflows/unsafe.yml", "on:\n  pull_request_target:\njobs:\n  job:\n    steps:\n      - uses: actions/checkout@v4\n")
	installed, err := nativeValidationDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	findings, err := nativeValidateSecurity(`{"token":"ghp_fake"}`, installed)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, finding := range findings {
		found[finding.ID] = true
	}
	for _, id := range []string{"unsafe-pull-request-target", "unpinned-third-party-action", "credential-in-policy", "orchestrator-can-mutate-target", "credential-in-dispatch-envelope", "worker-can-dispatch-workflow"} {
		if !found[id] {
			t.Errorf("missing finding %s", id)
		}
	}
	policy := map[string]any{"control-plane": map[string]any{"campaigns": map[string]any{"one": map[string]any{}}}}
	resolution := nativeValidateDeclarations(policy, installed)
	if len(resolution) != 1 || resolution[0].ID != "invalid-policy-resolution" {
		t.Fatalf("resolution findings = %#v", resolution)
	}
}
