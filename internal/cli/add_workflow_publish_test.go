package cli

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

type workflowAddPrompt struct {
	publish, run bool
	questions    []string
	target       string
}

func (p *workflowAddPrompt) Confirm(label string, defaultYes bool) (bool, error) {
	if defaultYes {
		return false, errors.New("workflow prompts must default to No")
	}
	p.questions = append(p.questions, label)
	switch label {
	case "Commit and push these CAO workflow changes?":
		return p.publish, nil
	case "Run this published workflow now?":
		return p.run, nil
	default:
		return false, errors.New("unexpected confirmation: " + label)
	}
}

func (p *workflowAddPrompt) Text(label, _ string) (string, error) {
	if label == "First run input target_repo" {
		return p.target, nil
	}
	return "", errors.New("unexpected input: " + label)
}

const workflowDispatchFixture = "---\nif: needs.pre_activation.outputs.cao_authorized == 'true'\nimports:\n  - uses: shared/control.md\n    with:\n      role: standalone\n      workflow: repo-status\non:\n  workflow_dispatch:\n    inputs:\n      target_repo:\n        required: true\n        type: string\n      safe_output_mode:\n        type: choice\n        default: live\n        options: [review, live]\n      safe_output_repo:\n        type: string\n      max_repos:\n        type: number\n---\nReport.\n"

func TestWorkflowAddPublicationAndFirstRun(t *testing.T) {
	for _, tt := range []struct {
		name         string
		publish, run bool
	}{
		{"decline publication", false, false},
		{"decline first run", true, false},
		{"approve both", true, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cmd, baseGH, remote, _ := setupPublishFixture(t, true)
			writeTestFile(t, policyPath, strings.ReplaceAll(standalonePolicy, "acme", "org"))
			setupPublishTestGit(t, cmd, "add", policyPath)
			setupPublishTestGit(t, cmd, "commit", "--quiet", "-m", "Review scoped policy")
			setupPublishTestGit(t, cmd, "push", "--quiet", "origin", "main")
			writeTestFile(t, "notes.txt", "unrelated dirty file")
			writeTestFile(t, ".github/consumer.txt", "unrelated GitHub configuration")
			var runs [][]string
			gh := func(ctx context.Context, args ...string) (string, string, error) {
				switch {
				case args[0] == "aw" && args[1] == "add":
					installWorkflowFixture(t, workflowDispatchFixture)
					return "", "", nil
				case args[0] == "aw" && args[1] == "compile":
					return "", "", nil
				case args[0] == "aw" && args[1] == "run":
					runs = append(runs, args)
					return `[{"workflow":"repo-status","lock_file":"repo-status.lock.yml","status":"triggered"}]`,
						"To see the workflow run, visit: https://github.com/org/control/actions/runs/42\nTriggered workflow: repo-status.lock.yml\nView workflow run: https://github.com/org/control/actions/runs/42\n", nil
				case args[0] == "repo":
					return "org/control", "", nil
				case strings.Contains(strings.Join(args, " "), "/actions/workflows/"):
					return `{"path":".github/workflows/repo-status.lock.yml","state":"active"}`, "", nil
				case strings.Contains(strings.Join(args, " "), "/actions/runs/"):
					commit := setupPublishTestGit(t, cmd, "rev-parse", "HEAD")
					return `{"head_sha":"` + commit + `","path":".github/workflows/repo-status.lock.yml","event":"workflow_dispatch","html_url":"https://github.com/org/control/actions/runs/42"}`, "", nil
				default:
					return baseGH(ctx, args...)
				}
			}
			prompt := &workflowAddPrompt{publish: tt.publish, run: tt.run, target: "org/target"}
			root, stdout, _ := testCommand(t, gh, nil)
			root.SetContext(context.WithValue(cmd.Context(), nativeSetupPromptKey{}, nativeSetupPrompt(prompt)))
			root.SetArgs([]string{"add", "repo-status"})
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			publication := result["publication"].(map[string]any)
			wantStatus, questions := "declined", 1
			if tt.publish {
				wantStatus, questions = "published", 2
			}
			if publication["status"] != wantStatus || len(prompt.questions) != questions {
				t.Fatalf("publication=%v prompts=%v", publication, prompt.questions)
			}
			if tt.run {
				commit := publication["commit"].(string)
				want := [][]string{{"aw", "run", ".github/workflows/repo-status.md", "--ref", "main", "--json",
					"--raw-field", "max_repos=1", "--raw-field", "safe_output_mode=review",
					"--raw-field", "safe_output_repo=org/control", "--raw-field", "target_repo=org/target"}}
				if !reflect.DeepEqual(runs, want) {
					t.Fatalf("runs=%q, want %q", runs, want)
				}
				if result["firstRun"].(map[string]any)["commit"] != commit {
					t.Fatal("run revision was not verified")
				}
			} else if len(runs) != 0 {
				t.Fatalf("implicit dispatch: %q", runs)
			}
			if tt.publish {
				paths := setupPublishTestGit(t, cmd, "show", "--pretty=format:", "--name-only", "HEAD")
				if strings.Contains(paths, "notes.txt") || strings.Contains(paths, "consumer.txt") {
					t.Fatalf("unrelated work published: %s", paths)
				}
				head := setupPublishTestGit(t, cmd, "--git-dir="+remote, "rev-parse", "refs/heads/main")
				if head != publication["commit"] {
					t.Fatal("published commit not on fixture remote")
				}
				prompt.questions = nil
				root, _, _ = testCommand(t, gh, nil)
				root.SetContext(context.WithValue(cmd.Context(), nativeSetupPromptKey{}, nativeSetupPrompt(prompt)))
				root.SetArgs([]string{"add", "repo-status", "--force"})
				if err := root.Execute(); err != nil {
					t.Fatal(err)
				}
				if len(prompt.questions) != 0 {
					t.Fatalf("unchanged add prompted again: %v", prompt.questions)
				}
			}
			for _, filename := range []string{"notes.txt", ".github/consumer.txt"} {
				if _, err := os.Stat(filename); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestWorkflowAddFilesPreservesDirtyWork(t *testing.T) {
	for _, tt := range []struct {
		name          string
		before, after map[string]string
		blocked       bool
		count         int
	}{
		{"unchanged", map[string]string{policyPath: "same"}, map[string]string{policyPath: "same"}, false, 0},
		{"unrelated dirty", map[string]string{".github/consumer": "same"}, map[string]string{".github/consumer": "same", policyPath: "new"}, false, 3},
		{"pre-existing policy", map[string]string{policyPath: "old"}, map[string]string{policyPath: "new"}, true, 0},
		{"pre-existing source", map[string]string{".github/workflows/repo-status.md": "same"}, map[string]string{".github/workflows/repo-status.md": "same", policyPath: "new"}, true, 0},
		{"pre-existing shared import", map[string]string{".github/workflows/shared/control.md": "same"}, map[string]string{".github/workflows/shared/control.md": "same", policyPath: "new"}, true, 0},
		{"outside installation", nil, map[string]string{"notes.txt": "new"}, true, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			files, blocked := workflowAddFiles(tt.before, tt.after, "repo-status")
			if (blocked != "") != tt.blocked || len(files) != tt.count {
				t.Fatalf("files=%v blocked=%s", files, blocked)
			}

		})
	}
}

func TestWorkflowAddCIDoesNotPromptOrPublish(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("CI", "true")
	writeTestFile(t, policyPath, standalonePolicy)
	prompt := &workflowAddPrompt{publish: true, run: true}
	root, stdout, _ := testCommand(t, func(_ context.Context, args ...string) (string, string, error) {
		if args[0] != "aw" || (args[1] != "add" && args[1] != "compile") {
			t.Fatalf("noninteractive add attempted publication or dispatch: %q", args)
		}
		installWorkflowFixture(t, workflowDispatchFixture)
		return "", "", nil
	}, nil)
	root.SetContext(context.WithValue(context.Background(), nativeSetupPromptKey{}, nativeSetupPrompt(prompt)))
	root.SetArgs([]string{"add", "repo-status"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(prompt.questions) != 0 || strings.Contains(stdout.String(), `"publication"`) || strings.Contains(stdout.String(), `"firstRun"`) {
		t.Fatalf("CI prompted or published: %v %s", prompt.questions, stdout)
	}
}

func TestWorkflowFirstRunPolicy(t *testing.T) {
	for _, tt := range []struct {
		name, entry, target string
		valid               bool
	}{
		{"scoped review", `{"mode":"review","max-mode":"review"}`, "acme/target", true},
		{"disabled", `{"enabled":false}`, "acme/target", false},
		{"wildcard", `{}`, "acme/*", false},
		{"outside owner", `{}`, "other/target", false},
		{"outside repository", `{}`, "acme/other", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			policyText := strings.Replace(standalonePolicy, `"campaigns":`, `"workflows":{"repo-status":`+tt.entry+`},"campaigns":`, 1)
			policy, err := nativeDecodeJSON([]byte(policyText))
			if err != nil {
				t.Fatal(err)
			}
			err = workflowFirstRunPolicy(policy.(map[string]any), "repo-status", "acme/control", tt.target)
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v error=%v", tt.valid, err)
			}
		})
	}
}

func TestNativeStandaloneWorkflowPolicy(t *testing.T) {
	for _, entry := range []string{
		`{}`, `{"enabled":false,"mode":"live","max-mode":"review","max-repositories":2,"rollout-percent":5,"monthly-ai-credit-budget":50,"targets":{"acme/target":{"mode":"review"}}}`,
	} {
		t.Run(entry, func(t *testing.T) {
			text := strings.Replace(standalonePolicy, `"campaigns":`, `"workflows":{"repo-status":`+entry+`},"campaigns":`, 1)
			value, err := nativeDecodeJSON([]byte(text))
			if err != nil {
				t.Fatal(err)
			}

			if err := nativeValidatePolicy(value.(map[string]any)); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, entry := range []string{
		`{"permissions":"write"}`, `{"max-repositories":1001}`, `{"targets":{"other/repo":{"mode":"live"}}}`,
	} {
		text := strings.Replace(standalonePolicy, `"campaigns":`, `"workflows":{"repo-status":`+entry+`},"campaigns":`, 1)
		value, err := nativeDecodeJSON([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		if err := nativeValidatePolicy(value.(map[string]any)); err == nil {
			t.Fatalf("invalid standalone policy accepted: %s", entry)
		}
	}
}

func TestWorkflowActivatedRunIDUsesOnlyNativeDispatchIdentity(t *testing.T) {
	for _, tt := range []struct {
		name, output, status string
		valid                bool
	}{
		{"native URL", "To see the workflow run, visit:\nhttps://github.com/acme/control/actions/runs/42\nTriggered workflow: repo-status.lock.yml\nView workflow run: https://github.com/acme/control/actions/runs/42", "triggered", true},
		{"latest fallback", "Triggered workflow: repo-status.lock.yml\nView workflow run: https://github.com/acme/control/actions/runs/42", "triggered", false},
		{"different repository", "https://github.com/other/control/actions/runs/42\nTriggered workflow: repo-status.lock.yml", "triggered", false},
		{"ambiguous activation", "https://github.com/acme/control/actions/runs/42\nhttps://github.com/acme/control/actions/runs/43\nTriggered workflow: repo-status.lock.yml", "triggered", false},
		{"failed summary", "https://github.com/acme/control/actions/runs/42\nTriggered workflow: repo-status.lock.yml", "error", false},
		{"missing marker", "https://github.com/acme/control/actions/runs/42", "triggered", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			runID, err := workflowActivatedRunID(`[{"status":"`+tt.status+`"}]`, tt.output, "github.com", "acme/control")
			if (err == nil) != tt.valid || tt.valid && runID != 42 {
				t.Fatalf("runID=%d valid=%v error=%v", runID, tt.valid, err)
			}
		})
	}
}

func TestWorkflowFirstRunFailsClosed(t *testing.T) {
	for _, tt := range []struct {
		name, target, want string
	}{
		{"missing target", "", "requires input target_repo"},
		{"outside scope", "other/target", "outside explicit CAO scope"},
		{"disabled", "acme/target", "disabled"},
		{"unavailable", "acme/target", "not available"},
		{"remote moved", "acme/target", "remote branch changed"},
		{"moves after approval", "acme/target", "remote branch changed"},
		{"unknown dispatch", "acme/target", "dispatch result is unknown"},
		{"unverified run", "acme/target", "dispatch result is unknown"},
		{"wrong run revision", "acme/target", "does not match"},
		{"wrong workflow", "acme/target", "does not match"},
		{"unavailable run", "acme/target", "revision could not be verified"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cmd := nativeSetupTestCommand()
			policy := strings.Replace(standalonePolicy, `"campaigns":`, `"workflows":{"repo-status":{}},"campaigns":`, 1)
			if tt.name == "disabled" {
				policy = strings.Replace(policy, `"repo-status":{}`, `"repo-status":{"enabled":false}`, 1)
			}
			reads := 0
			cmd.SetContext(context.WithValue(cmd.Context(), setupGitKey{}, setupGitFunc(func(_ *cobra.Command, _ string, args ...string) (string, error) {
				switch args[0] {
				case "remote":
					return "https://github.com/acme/control.git\n", nil
				case "ls-remote":
					reads++
					commit := testCampaignSHA
					if tt.name == "remote moved" || tt.name == "moves after approval" && reads > 1 {
						commit = strings.Repeat("f", 40)
					}
					return commit + "\trefs/heads/main\n", nil
				case "show":
					if strings.HasSuffix(args[1], policyPath) {
						return policy, nil
					}
					return workflowDispatchFixture, nil
				default:
					t.Fatalf("unexpected git: %q", args)
					return "", nil
				}
			})))
			apiCalls, runs := 0, 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				if args[0] == "api" {
					apiCalls++
					if strings.Contains(args[len(args)-1], "/actions/runs/") {
						if tt.name == "unavailable run" {
							return "", "404", errors.New("exit 1")
						}
						commit, path := testCampaignSHA, ".github/workflows/repo-status.lock.yml"
						if tt.name == "wrong run revision" {
							commit = strings.Repeat("f", 40)
						}
						if tt.name == "wrong workflow" {
							path = ".github/workflows/other.lock.yml"
						}
						return `{"head_sha":"` + commit + `","path":"` + path + `","event":"workflow_dispatch"}`, "", nil
					}
					if tt.name == "unavailable" {
						return "", "404 not found", errors.New("exit 1")
					}
					return `{"path":".github/workflows/repo-status.lock.yml","state":"active"}`, "", nil
				}
				if args[0] != "aw" || args[1] != "run" {
					t.Fatalf("unexpected gh: %q", args)
				}
				runs++
				if tt.name == "unverified run" {
					return `[{"status":"triggered"}]`, "", nil
				}
				if tt.name == "wrong run revision" || tt.name == "wrong workflow" || tt.name == "unavailable run" {
					return `[{"status":"triggered"}]`,
						"To see the workflow run, visit: https://github.com/acme/control/actions/runs/42\nTriggered workflow: repo-status.lock.yml\n", nil
				}
				return "", "connection lost", errors.New("exit 1")
			}
			prompt := &workflowAddPrompt{run: true, target: tt.target}
			_, err := offerWorkflowFirstRun(cmd, gh, prompt, "repo-status", map[string]any{
				"repository": "acme/control", "commit": testCampaignSHA, "branch": "main",
			})
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error=%v want=%s", err, tt.want)
			}
			wantRuns := 0
			if tt.name == "unknown dispatch" || tt.name == "unverified run" || tt.name == "wrong run revision" || tt.name == "wrong workflow" || tt.name == "unavailable run" {
				wantRuns = 1
			}
			maxAPICalls := 1
			if tt.name == "wrong run revision" || tt.name == "wrong workflow" || tt.name == "unavailable run" {
				maxAPICalls = 2
			}
			if runs != wantRuns || apiCalls > maxAPICalls {
				t.Fatalf("unsafe dispatch or retry: api=%d runs=%d", apiCalls, runs)
			}
		})
	}
}
