package cli

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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
	for _, test := range []struct{ output, id string }{
		{"invalid frontmatter", "invalid-frontmatter"},
		{"invalid permission", "invalid-permissions"},
		{"invalid safe-output", "invalid-safe-output"},
		{"invalid safe output", "invalid-safe-output"},
		{"invalid trigger", "invalid-trigger"},
		{"invalid tool", "invalid-tool"},
		{"invalid workflow", "invalid-workflow"},
		{"", "compile-error"},
	} {
		t.Run(test.id+" "+test.output, func(t *testing.T) {
			nativeManagementDirectory(t)
			writeTestFile(t, ".github/workflows/example.md", "---\n---\n")
			run := func(_ context.Context, _, program string, _ ...string) (string, error) {
				if program == "gh" {
					return test.output, errors.New("compiler failed")
				}
				return "", nil
			}
			findings, err := nativeCompileCompare(context.Background(), run, "v1.0.0")
			if err != nil || len(findings) != 1 || findings[0].ID != test.id || findings[0].Observed == "" {
				t.Fatalf("classification = %#v, %v", findings, err)
			}
		})
	}
}

func TestNativeValidationGeneratedWorkflowCoverage(t *testing.T) {
	metadata := "# gh-aw-metadata: {\"compiler_version\":\"v0.92.0\"}\n"
	for _, test := range []struct{ name, checkedIn, generated, id string }{
		{"clean", metadata, metadata, ""},
		{"missing", "", metadata, "missing-generated-workflow"},
		{"stale", metadata, metadata + "regenerated\n", "stale-generated-workflow"},
		{"wrong compiler", "# gh-aw-metadata: {\"compiler_version\":\"v0.1.0\"}\n", "", "unexpected-compiler-version"},
		{"malformed metadata", "# gh-aw-metadata: not-json\n", "", "unexpected-compiler-version"},
		{"missing metadata", "# workflow\n", "", "unexpected-compiler-version"},
	} {
		t.Run(test.name, func(t *testing.T) {
			nativeManagementDirectory(t)
			writeTestFile(t, ".github/workflows/example.md", "---\non: workflow_dispatch\n---\n")
			if test.checkedIn != "" {
				writeTestFile(t, ".github/workflows/example.lock.yml", test.checkedIn)
			}
			run := func(_ context.Context, directory, program string, _ ...string) (string, error) {
				if program == "gh" && test.generated != "" {
					return "", os.WriteFile(filepath.Join(directory, ".github/workflows/example.lock.yml"), []byte(test.generated), 0o644)
				}
				return "", nil
			}
			findings, err := nativeCompileCompare(context.Background(), run, "v0.92.0")
			if err != nil {
				t.Fatal(err)
			}
			if test.id == "" {
				if len(findings) != 0 {
					t.Fatalf("clean findings = %#v", findings)
				}
			} else if len(findings) != 1 || findings[0].ID != test.id {
				t.Fatalf("findings = %#v; expected %s", findings, test.id)
			}
		})
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

func nativeValidationFixture(t *testing.T) {
	t.Helper()
	nativeManagementDirectory(t)
	t.Setenv("GITHUB_REPOSITORY", "local/control")
	writeTestFile(t, policyPath, `{"version":1,"gh-aw-version":"v0.92.0","control-plane":{"campaigns":{"sample":{"workers":{"worker":{"workflow":"sample-worker"}}}}}}`)
	writeTestFile(t, "sample/cao.json", `{"campaign":"sample","orchestrator":"sample","workers":{"worker":"sample-worker"}}`)
	for _, workflow := range []string{"sample", "sample-worker"} {
		writeTestFile(t, ".github/workflows/"+workflow+".md", "---\non: workflow_dispatch\n---\n")
		writeTestFile(t, ".github/workflows/"+workflow+".lock.yml", "# gh-aw-metadata: {\"compiler_version\":\"v0.92.0\"}\n")
	}
}

func TestNativeValidationPolicyAndDeclarationCoverage(t *testing.T) {
	for _, test := range []struct {
		name, id string
		change   func(*testing.T)
	}{
		{"invalid policy", "invalid-cao-policy", func(t *testing.T) {
			writeTestFile(t, policyPath, `{"version":2}`)
		}},
		{"absent from policy", "installed-campaign-absent-from-policy", func(t *testing.T) {
			writeTestFile(t, policyPath, `{"version":1,"gh-aw-version":"v0.92.0","control-plane":{}}`)
		}},
		{"missing worker", "missing-workflow", func(t *testing.T) {
			if err := os.Remove(".github/workflows/sample-worker.md"); err != nil {
				t.Fatal(err)
			}
		}},
		{"not installed", "policy-campaign-not-installed", func(t *testing.T) {
			if err := os.Remove("sample/cao.json"); err != nil {
				t.Fatal(err)
			}
		}},
		{"invalid declaration", "invalid-campaign-declaration", func(t *testing.T) {
			writeTestFile(t, "sample/cao.json", "{invalid")
		}},
		{"unknown worker", "invalid-policy-resolution", func(t *testing.T) {
			writeTestFile(t, policyPath, `{"version":1,"gh-aw-version":"v0.92.0","control-plane":{"campaigns":{"sample":{}}}}`)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			nativeValidationFixture(t)
			test.change(t)
			gh := func(_ context.Context, args ...string) (string, string, error) {
				switch strings.Join(args[:2], " ") {
				case "aw version":
					return "v0.92.0", "", nil
				case "aw doctor":
					return "{}", "", nil
				case "workflow list":
					return "[]", "", nil
				default:
					t.Fatalf("unexpected call: %q", args)
					return "", "", nil
				}
			}
			run := func(context.Context, string, string, ...string) (string, error) { return "", nil }
			report := nativeValidateRepository(context.Background(), gh, run, false)
			for _, finding := range report.Findings {
				if finding.ID == test.id && report.ExitCode == 1 {
					return
				}
			}
			t.Fatalf("expected %s and exit 1: %#v", test.id, report)
		})
	}
}

func TestNativeValidationEnablementCoverage(t *testing.T) {
	installed := []nativeInstalledDeclaration{{name: "sample", file: "sample/cao.json", declaration: &campaignDeclaration{
		Campaign: "sample", Orchestrator: "sample", Workers: []campaignWorker{{Name: "worker", Workflow: "sample-worker"}},
	}}}
	for _, test := range []struct{ orchestrator, worker, id, severity string }{
		{"active", "active", "", ""},
		{"active", "disabled_manually", "campaign-partially-disabled", "warning"},
		{"disabled_manually", "active", "campaign-orchestrator-paused", "note"},
		{"disabled_manually", "unknown", "", ""},
		{"disabled_manually", "disabled_inactivity", "campaign-partially-disabled", "warning"},
		{"disabled_manually", "disabled_manually", "", ""},
	} {
		t.Run(test.orchestrator+"/"+test.worker, func(t *testing.T) {
			calls := 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				calls++
				if !reflect.DeepEqual(args, []string{"workflow", "list", "--all", "--json", "path,state"}) {
					t.Fatalf("unexpected call: %q", args)
				}
				content, err := json.Marshal([]map[string]string{
					{"path": "/.github/workflows/sample.lock.yml", "state": test.orchestrator},
					{"path": ".github/workflows/sample-worker.lock.yml", "state": test.worker},
				})
				return string(content), "", err
			}
			findings := nativeValidateEnablement(context.Background(), gh, installed)
			if calls != 1 {
				t.Fatalf("registry calls = %d", calls)
			}
			if test.id == "" {
				if len(findings) != 0 {
					t.Fatalf("unexpected findings: %#v", findings)
				}
			} else if len(findings) != 1 || findings[0].ID != test.id || findings[0].Severity != test.severity {
				t.Fatalf("findings = %#v", findings)
			}
		})
	}
	for _, output := range []string{"", "not-json"} {
		findings := nativeValidateEnablement(context.Background(), func(context.Context, ...string) (string, string, error) {
			if output == "" {
				return "", "offline", errors.New("unavailable")
			}
			return output, "", nil
		}, installed)
		if len(findings) != 1 || findings[0].ID != "github-enablement-state-unavailable" || findings[0].Severity != "warning" {
			t.Fatalf("unavailable findings = %#v", findings)
		}
	}
}

func TestNativeValidationProtectedPublisherExceptionIsExact(t *testing.T) {
	nativeManagementDirectory(t)
	writeTestFile(t, ".github/workflows/package.yml", `jobs:
	  reviewed:
	    uses: githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main # zizmor: ignore[unpinned-uses] protected default-branch publisher
	  unreviewed:
	    uses: githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main
	  other:
	    uses: githubnext/gh-aw-cao/.github/workflows/other.yml@main
	  external:
	    steps:
	      - uses: someone/action@main
	`)
	findings, err := nativeValidateSecurity("{}", nil)
	if err != nil {
		t.Fatal(err)
	}
	observed := []any{}
	for _, finding := range findings {
		observed = append(observed, finding.Observed)
	}
	if !reflect.DeepEqual(observed, []any{
		"githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main",
		"githubnext/gh-aw-cao/.github/workflows/other.yml@main",
		"someone/action@main",
	}) {
		t.Fatalf("unreviewed actions = %#v", findings)
	}
}

func TestNativeValidationInfrastructureFailureIsExitTwo(t *testing.T) {
	nativeValidationFixture(t)
	gh := func(context.Context, ...string) (string, string, error) { return "v0.92.0", "", nil }
	run := func(context.Context, string, string, ...string) (string, error) {
		return "", errors.New("executor failed")
	}
	report := nativeValidateRepository(context.Background(), gh, run, false)
	if report.ExitCode != 2 || report.Summary["errors"] != 1 || report.Findings[0].ID != "validator-failure" {
		t.Fatalf("infrastructure report = %#v", report)
	}
}

func TestNativeValidationDoctorSeesOnlyActualCheckoutChanges(t *testing.T) {
	nativeValidationFixture(t)
	for _, args := range [][]string{
		{"init", "--quiet"}, {"add", "--all"},
		{"-c", "user.name=CAO Test", "-c", "user.email=cao-test@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "Clean fixture"},
	} {
		if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("prepare clean checkout: %v\n%s", err, output)
		}
	}
	gh := func(ctx context.Context, args ...string) (string, string, error) {
		switch strings.Join(args[:2], " ") {
		case "aw version":
			return "v0.92.0", "", nil
		case "workflow list":
			return "[]", "", nil
		case "aw doctor":
			status, err := exec.CommandContext(ctx, "git", "status", "--porcelain").Output()
			if err != nil {
				return "", "", err
			}
			if len(status) != 0 {
				return "", "working directory has uncommitted changes", errors.New("dirty checkout")
			}
			return "{}", "", nil
		default:
			t.Fatalf("unexpected call: %q", args)
			return "", "", nil
		}
	}
	run := func(ctx context.Context, directory, program string, args ...string) (string, error) {
		if program == "gh" {
			return "", nil
		}
		return nativeValidationExec(ctx, directory, program, args...)
	}
	reportPath := filepath.Join(t.TempDir(), "cao-validation.json")
	for _, dirty := range []bool{false, true} {
		if dirty {
			writeTestFile(t, "uncommitted.txt", "Actual checkout change\n")
		}
		file, err := os.Create(reportPath)
		if err != nil {
			t.Fatal(err)
		}
		report := nativeValidateRepository(context.Background(), gh, run, false)
		if err := json.NewEncoder(file).Encode(report); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		expectedWarnings := 0
		if dirty {
			expectedWarnings = 1
		}
		if report.ExitCode != 0 || report.Summary["errors"] != 0 || report.Summary["warnings"] != expectedWarnings {
			t.Fatalf("dirty %v: %#v", dirty, report)
		}
		if dirty && (len(report.Findings) != 1 || report.Findings[0].ID != "doctor-check-failed") {
			t.Fatalf("doctor findings = %#v", report.Findings)
		}
		status, err := exec.Command("git", "status", "--porcelain").Output()
		if err != nil || (!dirty && len(status) != 0) || (dirty && strings.TrimSpace(string(status)) != "?? uncommitted.txt") {
			t.Fatalf("validator dirtied the checkout: %v\n%s", err, status)
		}
	}
}
