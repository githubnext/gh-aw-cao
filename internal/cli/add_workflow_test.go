package cli

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const standaloneFixture = "---\nif: needs.pre_activation.outputs.cao_authorized == 'true'\nimports:\n  - uses: shared/control.md\n    with:\n      role: standalone\n      workflow: repo-status\n---\nReport.\n"
const standalonePolicy = `{"version":1,"gh-aw-version":"v0.92.6","control-plane":{"scope":{"allowed-owners":["acme"],"allowed-repositories":["acme/control","acme/target"]},"defaults":{"mode":"live","max-repositories":100,"rollout-percent":20},"campaigns":{"other":{"enabled":false,"mode":"review"}}}}`

func installWorkflowFixture(t *testing.T, source string) {
	t.Helper()
	writeTestFile(t, ".github/workflows/repo-status.md", source)
	writeTestFile(t, ".github/workflows/repo-status.lock.yml", "name: Repo Status\n")
}

func TestStandaloneWorkflowSpecs(t *testing.T) {
	for _, tt := range []struct{ input, spec string }{
		{"repo-status", "githubnext/gh-cao/.github/workflows/repo-status.md"},
		{"repo-status@feature/report", "githubnext/gh-cao/.github/workflows/repo-status.md@feature/report"},
		{"githubnext/gh-cao/repo-status@v1.2.3", "githubnext/gh-cao/.github/workflows/repo-status.md@v1.2.3"},
		{"githubnext/gh-cao/.github/workflows/repo-status.md@main", "githubnext/gh-cao/.github/workflows/repo-status.md@main"},
		{"https://github.com/githubnext/gh-cao/blob/main/.github/workflows/repo-status.md", "https://github.com/githubnext/gh-cao/blob/main/.github/workflows/repo-status.md"},
		{"./reports/repo-status.md", "./reports/repo-status.md"},
		{"acme/workflows/reports/repo-status.md@release", "acme/workflows/reports/repo-status.md@release"},
	} {
		t.Run(tt.input, func(t *testing.T) {
			spec, name, err := standaloneWorkflowSpec(tt.input)
			if err != nil || spec != tt.spec || name != "repo-status" {
				t.Fatalf("spec=%q name=%q error=%v", spec, name, err)
			}
		})
	}
}

func TestAddStandaloneRegistersReviewPolicy(t *testing.T) {
	t.Chdir(t.TempDir())
	writeTestFile(t, policyPath, standalonePolicy)
	var calls [][]string
	gh := func(_ context.Context, args ...string) (string, string, error) {
		calls = append(calls, args)
		installWorkflowFixture(t, standaloneFixture)
		return "", "", nil
	}
	root, stdout, _ := testCommand(t, gh, nil)
	root.SetArgs([]string{"add", "repo-status@main", "--force", "--engine", "copilot"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	wantCalls := [][]string{
		{"aw", "add", "githubnext/gh-cao/.github/workflows/repo-status.md@main", "--dir", ".github/workflows", "--force", "--engine", "copilot"},
		{"aw", "compile", ".github/workflows/repo-status.md", "--strict", "--schedule-seed", catalogRepository, "--no-check-update"},
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("gh calls=%q, want %q", calls, wantCalls)
	}
	policy, err := nativeReadValidatedPolicy()
	if err != nil {
		t.Fatal(err)
	}
	var before map[string]any
	if err := json.Unmarshal([]byte(standalonePolicy), &before); err != nil {
		t.Fatal(err)
	}
	entry := map[string]any{"mode": "review", "max-mode": "review", "max-repositories": 1}
	before["control-plane"].(map[string]any)["workflows"] = map[string]any{"repo-status": entry}
	want, _ := json.Marshal(before)
	got, _ := json.Marshal(policy)
	if string(got) != string(want) {
		t.Fatalf("policy=%s, want %s", got, want)
	}
	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || result["workflow"] != "repo-status" || result["policy"] != policyPath {
		t.Fatalf("result=%s error=%v", stdout, err)
	}
}

func TestAddStandalonePreservesExistingRegistrationOnRepeat(t *testing.T) {
	for _, entry := range []string{`{}`, `{"enabled":false,"mode":"live","max-mode":"live","max-repositories":3,"rollout-percent":5,"monthly-ai-credit-budget":20,"targets":{"acme/target":{"mode":"review"}}}`} {
		t.Run(entry, func(t *testing.T) {
			t.Chdir(t.TempDir())
			original := strings.Replace(standalonePolicy, `"campaigns":`, `"workflows":{"repo-status":`+entry+`},"campaigns":`, 1)
			writeTestFile(t, policyPath, original)
			for range 2 {
				root, _, _ := testCommand(t, func(context.Context, ...string) (string, string, error) {
					installWorkflowFixture(t, standaloneFixture)
					return "", "", nil
				}, nil)
				root.SetArgs([]string{"add", "repo-status", "--force"})
				if err := root.Execute(); err != nil {
					t.Fatal(err)
				}
				got, err := os.ReadFile(policyPath)
				if err != nil || string(got) != original {
					t.Fatalf("existing policy rewritten: %s %v", got, err)
				}
			}
		})
	}
}

func TestAddStandaloneCreatesPolicyOnlyAfterInstall(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{true: "failure", false: "success"}[fail], func(t *testing.T) {
			t.Chdir(t.TempDir())
			root, stdout, _ := testCommand(t, func(_ context.Context, args ...string) (string, string, error) {
				switch args[0] + " " + args[1] {
				case "aw version":
					return "gh-aw v0.92.6", "", nil
				case "repo view":
					return "acme/control", "", nil
				case "aw add":
					if _, err := os.Stat(policyPath); !errors.Is(err, os.ErrNotExist) {
						t.Fatal("policy written before successful install")
					}
					if fail {
						return "", "404 workflow not found", errors.New("exit 1")
					}
					installWorkflowFixture(t, standaloneFixture)
					return "", "", nil
				case "aw compile":
					return "", "", nil
				default:
					t.Fatalf("unexpected gh call: %q", args)
					return "", "", nil
				}
			}, nil)
			root.SetArgs([]string{"add", "repo-status"})
			err := root.Execute()
			if fail {
				if err == nil || !strings.Contains(err.Error(), "404") || stdout.Len() != 0 {
					t.Fatalf("error=%v stdout=%s", err, stdout)
				}
				if _, err := os.Stat(policyPath); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("failed install created policy")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			policy, err := nativeReadValidatedPolicy()
			if err != nil {
				t.Fatal(err)
			}
			control := policy["control-plane"].(map[string]any)
			scope := control["scope"].(map[string]any)
			if !reflect.DeepEqual(scope["allowed-repositories"], []any{"acme/control"}) || len(control["campaigns"].(map[string]any)) != 0 {
				t.Fatalf("scope or campaigns widened: %v", control)
			}
		})
	}
}

func TestAddStandaloneFailurePreservesPolicy(t *testing.T) {
	for _, tt := range []struct{ name, source, want string }{
		{"install", standaloneFixture, "installation denied"},
		{"compile", standaloneFixture, "compilation rejected"},
		{"missing source", "", "no such file"},
		{"missing lock", standaloneFixture, "no compiled lock"},
		{"not CAO", "---\nif: needs.pre_activation.outputs.cao_authorized == 'true'\nname: Other\n---\n", "not a standalone"},
		{"missing gate", strings.Replace(standaloneFixture, "if: needs.pre_activation.outputs.cao_authorized == 'true'\n", "", 1), "pre-activation gate"},
		{"campaign", strings.Replace(standaloneFixture, "standalone", "worker", 1), "role: standalone"},
		{"identity", strings.Replace(standaloneFixture, "workflow: repo-status", "workflow: other", 1), "workflow: repo-status"},
		{"invalid YAML", "---\nimports: [\n---\n", "failed to parse frontmatter"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			writeTestFile(t, policyPath, standalonePolicy)
			root, stdout, _ := testCommand(t, func(_ context.Context, args ...string) (string, string, error) {
				if tt.name == "install" {
					return "", tt.want, errors.New("exit 1")
				}
				if tt.name == "compile" && args[1] == "compile" {
					return "", tt.want, errors.New("exit 1")
				}
				if tt.source != "" {
					installWorkflowFixture(t, tt.source)
				}
				if tt.name == "missing lock" {
					if err := os.Remove(".github/workflows/repo-status.lock.yml"); err != nil {
						t.Fatal(err)
					}
				}
				return "", "", nil
			}, nil)
			root.SetArgs([]string{"add", "repo-status"})
			err := root.Execute()
			if err == nil || !strings.Contains(err.Error(), tt.want) || stdout.Len() != 0 {
				t.Fatalf("error=%v want=%s stdout=%s", err, tt.want, stdout)
			}
			got, err := os.ReadFile(policyPath)
			if err != nil || string(got) != standalonePolicy {
				t.Fatalf("policy changed: %q %v", got, err)
			}
		})
	}
}

func TestAddStandaloneRejectsInvalidPolicyBeforeInstall(t *testing.T) {
	for _, policy := range []string{
		`{"version":2}`, `{"version":1,"version":1}`, `{"version":1,"control-plane":{"workflows":[]}}`,
		strings.Replace(standalonePolicy, `"campaigns":`, `"workflows":{"repo-status":null},"campaigns":`, 1),
	} {
		t.Run(policy, func(t *testing.T) {
			t.Chdir(t.TempDir())
			writeTestFile(t, policyPath, policy)
			root, _, _ := testCommand(t, nil, nil)
			root.SetArgs([]string{"add", "repo-status"})
			if err := root.Execute(); err == nil {
				t.Fatal("invalid policy accepted")
			}
		})
	}
}

func TestAddStandaloneRejectsPackagesAndUnsafeOptions(t *testing.T) {
	for _, args := range [][]string{
		{"add"}, {"add", "repo-status", "other"}, {"add", "githubnext/gh-cao"},
		{"add", "githubnext/gh-cao/dependabot/aw.yml"}, {"add", "./package"},
		{"add", "./*.md"}, {"add", "repo-status@"}, {"add", "daily-repo-status"},
		{"add", "githubnext/gh-cao/daily-repo-status"},
		{"add", "repo-status", "--name", "other"}, {"add", "repo-status", "--dir", "elsewhere"},
		{"add", "repo-status", "--pr"}, {"add", "repo-status", "--create-pull-request"},
		{"add", "https://user:password@example.test/repo-status.md"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			root, stdout, _ := testCommand(t, nil, nil)
			root.SetArgs(args)
			if err := root.Execute(); err == nil || stdout.Len() != 0 {
				t.Fatalf("invalid input accepted: %v %s", err, stdout)
			}
		})
	}
}

func TestAddStandaloneRejectsEscapingDestination(t *testing.T) {
	t.Chdir(t.TempDir())
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "cao.json"), standalonePolicy)
	if err := os.Mkdir(".github", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, ".github/workflows"); err != nil {
		t.Fatal(err)
	}
	root, _, _ := testCommand(t, nil, nil)
	root.SetArgs([]string{"add", "repo-status"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("error=%v", err)
	}
}
