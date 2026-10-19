package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func nativeQuickstartTestPolicy(t *testing.T) map[string]any {
	t.Helper()
	policy := nativeSetupTestPolicy()
	nativeSetupMap(nativeSetupMap(policy["control-plane"])["campaigns"])["repo-assist"] = map[string]any{
		"workers": map[string]any{
			"maintenance": map[string]any{"workflow": "repo-assist-maintenance"},
			"issue-fix":   map[string]any{"workflow": "repo-assist-issue-fix"},
		},
	}
	if err := nativeQuickstartConfigurePolicy(policy, "org/control", "other/target"); err != nil {
		t.Fatal(err)
	}
	return policy
}

func TestNativeQuickstartPolicySafety(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"live campaign", func(p map[string]any) {
			nativeSetupMap(nativeSetupMap(nativeSetupMap(p["control-plane"])["campaigns"])["repo-assist"])["mode"] = "live"
		}},
		{"live control", func(p map[string]any) { nativeSetupMap(p["control-plane"])["mode"] = "live" }},
		{"extra target", func(p map[string]any) {
			c := nativeSetupMap(nativeSetupMap(nativeSetupMap(p["control-plane"])["campaigns"])["repo-assist"])
			nativeSetupMap(c["targets"])["other/second"] = map[string]any{"mode": "review"}
		}},
		{"extra worker", func(p map[string]any) {
			c := nativeSetupMap(nativeSetupMap(nativeSetupMap(p["control-plane"])["campaigns"])["repo-assist"])
			nativeSetupMap(nativeSetupMap(c["workers"])["issue-fix"])["enabled"] = true
		}},
		{"larger rollout", func(p map[string]any) {
			nativeSetupMap(nativeSetupMap(nativeSetupMap(p["control-plane"])["campaigns"])["repo-assist"])["max-repositories"] = 2
		}},
		{"broad activity", func(p map[string]any) {
			nativeSetupMap(p["control-plane"])["activity"] = map[string]any{"repositories": []string{"org/control", "other/target"}}
		}},
		{"missing owner", func(p map[string]any) {
			nativeSetupMap(nativeSetupMap(p["control-plane"])["scope"])["allowed-owners"] = []string{"org"}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := nativeQuickstartTestPolicy(t)
			if _, _, err := nativeQuickstartCheckPolicy(policy, "org/control"); err != nil {
				t.Fatal(err)
			}
			test.edit(policy)
			if _, _, err := nativeQuickstartCheckPolicy(policy, "org/control"); err == nil {
				t.Fatal("unsafe policy accepted")
			}
		})
	}
}

func TestNativeQuickstartBoundedCommitPaths(t *testing.T) {
	for _, status := range []string{"?? .github/workflows/cao.json\n M activity/run.mjs\n", "?? .vscode/settings.json\n", " R old.txt -> repo-assist/new.txt\n", " M \"dashboard/a\\tb\"\n", " D cao.sh\n"} {
		if err := nativeQuickstartCheckPaths(status, true); err != nil {
			t.Fatalf("rejected allowed status %q: %v", status, err)
		}
	}
	for _, status := range []string{"M  .github/workflows/cao.json\n", "?? unrelated.txt\n", "?? .github-backup/token\n", "?? .vscode/launch.json\n", "?? cao.sh\n", " M cao.sh\n", "D  cao.sh\n"} {
		if err := nativeQuickstartCheckPaths(status, true); err == nil {
			t.Fatalf("accepted unsafe status %q", status)
		}
	}
}

func TestNativeQuickstartPauseEvenWhenDispatchFails(t *testing.T) {
	for _, failAt := range []string{"enable", "run", "disable", ""} {
		t.Run(failAt, func(t *testing.T) {
			calls := []string{}
			gh := func(_ context.Context, args ...string) (string, string, error) {
				call := strings.Join(args, " ")
				calls = append(calls, call)
				if args[1] == failAt {
					return "", "failed", errors.New("failure")
				}
				return "", "", nil
			}
			err := nativeQuickstartDispatchReview(nativeSetupTestCommand(), gh, "org/control", "main", "other/target", true, 1)
			if (err != nil) != (failAt != "") {
				t.Fatalf("err=%v failAt=%s", err, failAt)
			}
			if !strings.HasPrefix(calls[len(calls)-1], "workflow disable repo-assist.lock.yml") {
				t.Fatalf("orchestrator was not paused: %v", calls)
			}
			for _, call := range calls {
				if strings.Contains(call, "workflow run") {
					for _, field := range []string{"target_repo=other/target", "safe_output_repo=org/control", "max_repos=1", "rollout_percent=100", "safe_output_mode=review"} {
						if !strings.Contains(call, "--raw-field "+field) {
							t.Fatalf("missing bounded field %s: %s", field, call)
						}
					}
				}
			}
		})
	}
}

func TestNativeQuickstartCancellationStillPauses(t *testing.T) {
	cmd := nativeSetupTestCommand()
	ctx, cancel := context.WithCancel(cmd.Context())
	defer cancel()
	cmd.SetContext(ctx)
	paused := false
	gh := func(ctx context.Context, args ...string) (string, string, error) {
		switch args[1] {
		case "run":
			cancel()
			return "", "", context.Canceled
		case "disable":
			if ctx.Err() != nil {
				t.Fatal("cancellation prevented the schedule-pause attempt")
			}
			paused = true
		}
		return "", "", nil
	}
	if err := nativeQuickstartDispatchReview(cmd, gh, "org/control", "main", "other/target", true, 1); err == nil || !paused {
		t.Fatalf("cancelled dispatch did not pause: err=%v paused=%v", err, paused)
	}
}

func nativeQuickstartTestGit(t *testing.T, root string) nativeSetupExecFunc {
	t.Helper()
	return func(_ *cobra.Command, name string, _ io.Reader, args ...string) (string, error) {
		if name != "git" {
			t.Fatalf("unexpected executable %s", name)
		}
		switch strings.Join(args, " ") {
		case "rev-parse --show-toplevel":
			return root, nil
		case "branch --show-current":
			return "main", nil
		case "rev-parse --verify HEAD":
			return strings.Repeat("a", 40), nil
		case "diff --exit-code HEAD -- .github/workflows/cao.json .github/workflows":
			return "", nil
		case "ls-files --error-unmatch -- .github/workflows/cao.json":
			return policyPath, nil
		default:
			t.Fatalf("unexpected git mutation in staged quickstart: %v", args)
			return "", nil
		}
	}
}

func nativeQuickstartTestBaseGH(t *testing.T, args []string) (string, bool) {
	t.Helper()
	switch strings.Join(args, " ") {
	case "repo view --json nameWithOwner,visibility":
		return `{"nameWithOwner":"org/control","visibility":"PUBLIC"}`, true
	case "api repos/org/control --jq .default_branch":
		return "main", true
	case "api repos/org/control/commits/main --jq .sha":
		return strings.Repeat("a", 40), true
	case "repo view other/target --json nameWithOwner,visibility":
		return `{"nameWithOwner":"other/target","visibility":"PUBLIC"}`, true
	}
	return "", false
}

func TestNativeQuickstartStages(t *testing.T) {
	for _, stage := range []string{"run", "collect", "dashboard"} {
		t.Run(stage, func(t *testing.T) {
			root := nativeSetupTestDirectory(t)
			nativeSetupTestSave(t, nativeQuickstartTestPolicy(t))
			cmd := nativeSetupTestCommand()
			cmd.SetContext(context.WithValue(cmd.Context(), nativeSetupExecKey{}, nativeQuickstartTestGit(t, root)))
			calls := []string{}
			gh := func(_ context.Context, args ...string) (string, string, error) {
				call := strings.Join(args, " ")
				calls = append(calls, call)
				if out, ok := nativeQuickstartTestBaseGH(t, args); ok {
					return out, "", nil
				}
				if args[0] == "workflow" && stage != "dashboard" {
					return "", "", nil
				}
				if args[0] == "run" && args[1] == "list" {
					return "[]", "", nil
				}
				t.Fatalf("unexpected gh call in %s: %s", stage, call)
				return "", "", nil
			}
			result, err := nativeQuickstartStage(cmd, gh, stage)
			if err != nil {
				t.Fatal(err)
			}
			expected := "dispatched"
			if stage == "dashboard" {
				expected = "pending"
			}
			if result["step"] != stage || result["status"] != expected || result["targetRepository"] != "other/target" {
				t.Fatalf("invalid stage result %#v", result)
			}
			before, _ := os.ReadFile(policyPath)
			for _, call := range calls {
				if stage == "dashboard" && strings.Contains(call, "workflow run") {
					t.Fatalf("dashboard read-only check dispatched work: %s", call)
				}
				if strings.Contains(call, "variable set") || strings.Contains(call, "secret set") {
					t.Fatalf("stage changed credentials: %s", call)
				}
			}
			after, _ := os.ReadFile(policyPath)
			if string(before) != string(after) {
				t.Fatal("stage rewrote reviewed policy")
			}
		})
	}
}

func TestNativeQuickstartDashboardRequiresDeployAndEvidence(t *testing.T) {
	for _, fail := range []string{"", "artifact", "empty", "missing-shards", "malformed", "schema", "session", "lifecycle", "operational", "duplicate-shards", "identity", "deploy", "private-pages", "old-dashboard"} {
		t.Run(fail, func(t *testing.T) {
			root := nativeSetupTestDirectory(t)
			nativeSetupTestSave(t, nativeQuickstartTestPolicy(t))
			cmd := nativeSetupTestCommand()
			cmd.SetContext(context.WithValue(cmd.Context(), nativeSetupExecKey{}, nativeQuickstartTestGit(t, root)))
			gh := func(_ context.Context, args ...string) (string, string, error) {
				call := strings.Join(args, " ")
				if out, ok := nativeQuickstartTestBaseGH(t, args); ok {
					return out, "", nil
				}
				switch {
				case strings.HasPrefix(call, "run list") && strings.Contains(call, "--workflow cao-activity.yml"):
					return `[{"databaseId":12,"status":"completed","conclusion":"success","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:02:00Z","url":"https://example.test/activity"}]`, "", nil
				case call == "run view 12 --repo org/control --json databaseId,status,conclusion,createdAt,updatedAt,url":
					if fail == "identity" {
						return `{"databaseId":14,"status":"completed","conclusion":"success"}`, "", nil
					}
					return `{"databaseId":12,"status":"completed","conclusion":"success"}`, "", nil
				case strings.HasPrefix(call, "run download 12"):
					if fail == "artifact" {
						return "", "missing artifact", errors.New("missing")
					}
					if fail == "missing-shards" {
						return "", "", nil
					}
					directory := args[len(args)-1]
					shards := filepath.Join(directory, "gh-aw-logs-shards")
					if err := os.MkdirAll(shards, 0o700); err != nil {
						t.Fatal(err)
					}
					record := `{"schema_version":2,"kind":"workflow_runs","request":{"repository":"org/control"},"payload":[{"databaseId":10,"workflowName":"repo-assist","updatedAt":"2026-01-01T00:01:00Z"}]}`
					switch fail {
					case "empty":
						record = `{"schema_version":5,"kind":"future_kind"}`
					case "malformed":
						record = "not-json"
					case "schema":
						record = strings.Replace(record, `"schema_version":2`, `"schema_version":3`, 1)
					case "session":
						record += "\n" + `{"schema_version":5,"kind":"run","run":{"organization":"org","repository":"control","workflow_name":"repo-assist","workflow_path":"repo-assist.lock.yml","run_id":10,"updated_at":"2026-01-01T00:01:00Z","cao_unified_session":null}}`
					case "lifecycle":
						record += "\n" + `{"schema_version":5,"kind":"token_efficiency_lifecycle_observation","observation":{"optimizerRunId":10,"optimizerRunAttempt":1}}`
					case "operational":
						record += "\n" + `{"schema_version":5,"kind":"operational_value","operational_value":{"repository":"org/control","timestamp":"2026-01-02T00:00:00Z","value_id":"example","value":null}}`
					}
					if err := os.WriteFile(filepath.Join(shards, "org.jsonl"), []byte(record+"\n"), 0o600); err != nil {
						t.Fatal(err)
					}
					if fail == "duplicate-shards" {
						if err := os.WriteFile(filepath.Join(shards, "other.jsonl"), []byte(record+"\n"+record+"\n"), 0o600); err != nil {
							t.Fatal(err)
						}
					}
					return "", "", nil
				case strings.HasPrefix(call, "run list") && strings.Contains(call, "--workflow cao-dashboard.yml"):
					created := "2026-01-01T00:03:00Z"
					if fail == "old-dashboard" {
						created = "2026-01-01T00:01:00Z"
					}
					return `[{"databaseId":13,"status":"completed","conclusion":"success","createdAt":"` + created + `","url":"https://example.test/dashboard"}]`, "", nil
				case call == "run view 13 --repo org/control --json jobs":
					conclusion := "success"
					if fail == "deploy" {
						conclusion = "skipped"
					}
					return `{"jobs":[{"name":"build","status":"completed","conclusion":"success"},{"name":"deploy","status":"completed","conclusion":"` + conclusion + `"}]}`, "", nil
				case call == "api repos/org/control/pages":
					return `{"public":` + strings.ToLower(strconvBool(fail != "private-pages")) + `,"html_url":"https://org.github.io/control"}`, "", nil
				default:
					t.Fatalf("unexpected remote mutation or read: %s", call)
					return "", "", nil
				}
			}
			result, err := nativeQuickstartStage(cmd, gh, "dashboard")
			scratch, scratchErr := filepath.Glob(".cao-quickstart-evidence-*")
			if scratchErr != nil || len(scratch) != 0 {
				t.Fatalf("Activity scratch data was retained: %v %v", scratch, scratchErr)
			}
			auditFailure := map[string]string{
				"malformed":   "gh-aw JSONL line 1 must contain valid JSON",
				"schema":      "Unsupported gh-aw JSONL schema version at line 1: 3",
				"session":     "run.cao_unified_session must be an object",
				"lifecycle":   "Token lifecycle observations require retained optimizer runs: 10",
				"operational": "gh-aw JSONL line 2.operational_value.value must be a finite number",
			}[fail]
			if auditFailure != "" {
				if err == nil || err.Error() != auditFailure || result != nil {
					t.Fatalf("malformed Activity evidence must fail, not become pending: result=%v err=%v", result, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			expected := "pending"
			if fail == "" || fail == "duplicate-shards" {
				expected = "ready"
			}
			if result["status"] != expected {
				t.Fatalf("readiness=%v, expected %s", result, expected)
			}
			if expected == "ready" {
				activity := nativeSetupMap(result["activity"])
				expectedCount := 1
				if fail == "duplicate-shards" {
					expectedCount = 2
				}
				if len(activity) != 2 || activity["url"] != "https://example.test/activity" || activity["uniqueRuns"] != expectedCount {
					t.Fatalf("Activity public output differs: %v", activity)
				}
			}
			if fail == "artifact" || fail == "empty" || fail == "missing-shards" || fail == "identity" {
				if result["context"] != "The latest Activity snapshot has no verified data-bearing artifact. Inspect collection evidence and retry this read-only check." {
					t.Fatalf("missing Activity evidence changed the pending context: %v", result)
				}
			}
		})
	}
}

func strconvBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func TestNativeQuickstartRejectsUnpushedAndUnreviewedPolicy(t *testing.T) {
	for _, failure := range []string{"head", "policy"} {
		t.Run(failure, func(t *testing.T) {
			root := nativeSetupTestDirectory(t)
			policy := nativeQuickstartTestPolicy(t)
			if failure == "policy" {
				nativeSetupMap(policy["control-plane"])["activity"] = map[string]any{"repositories": []string{"other/target"}}
			}
			nativeSetupTestSave(t, policy)
			cmd := nativeSetupTestCommand()
			cmd.SetContext(context.WithValue(cmd.Context(), nativeSetupExecKey{}, nativeQuickstartTestGit(t, root)))
			gh := func(_ context.Context, args ...string) (string, string, error) {
				if strings.Contains(strings.Join(args, " "), "/commits/main") && failure == "head" {
					return strings.Repeat("b", 40), "", nil
				}
				if out, ok := nativeQuickstartTestBaseGH(t, args); ok {
					return out, "", nil
				}
				t.Fatalf("unsafe policy reached operation: %v", args)
				return "", "", nil
			}
			if _, err := nativeQuickstartStage(cmd, gh, "run"); err == nil {
				t.Fatal("unsafe state reached dispatch")
			}
		})
	}
}

func TestNativeQuickstartCountRuns(t *testing.T) {
	nativeSetupTestDirectory(t)
	path := "evidence.jsonl"
	good := `{"schema_version":2,"kind":"workflow_runs","request":{"repository":"org/control"},"payload":[{"databaseId":10,"workflowName":"repo-assist","updatedAt":"2026-01-01T00:01:00Z"}]}`
	for _, record := range []string{good + "\n" + good, strings.Replace(good, `"databaseId":10`, `"databaseId":null`, 1), strings.Replace(good, `"workflowName":"repo-assist"`, `"workflowName":""`, 1), `{"kind":"workflow_runs","payload":null}`, "not-json"} {
		if err := os.WriteFile(path, []byte(record+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		count, err := nativeQuickstartCountRuns(file)
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(record, good+"\n") {
			if err != nil || count != 1 {
				t.Fatalf("duplicate observations not deduplicated: %d %v", count, err)
			}
		} else if err == nil {
			t.Fatalf("malformed evidence accepted: %s", record)
		}
	}
}

func TestNativeQuickstartConfiguredPolicyValidation(t *testing.T) {
	policy := nativeQuickstartTestPolicy(t)
	data, _ := json.Marshal(policy)
	var normalized map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err := decoder.Decode(&normalized); err != nil {
		t.Fatal(err)
	}
	if err := nativeValidatePolicy(normalized); err != nil {
		t.Fatalf("generated quickstart policy invalid: %v", err)
	}

}

func TestNativeQuickstartInstallAndWait(t *testing.T) {
	for _, scenario := range []string{"install", "retired-launcher", "wait", "artifact", "empty", "malformed", "different-latest"} {
		t.Run(scenario, func(t *testing.T) {
			wait := scenario != "install" && scenario != "retired-launcher"
			root := nativeSetupTestDirectory(t)
			nativeSetupTestSave(t, nativeSetupTestPolicy())
			revision := strings.Repeat("a", 40)
			writeTestFile(t, ".github/aw/packages/root.json", `{"package":"githubnext/gh-cao/root","resolvedCommit":"`+revision+`"}`)
			declaration := `{"campaign":"repo-assist","orchestrator":"repo-assist","workers":{"maintenance":"repo-assist-maintenance","issue-fix":"repo-assist-issue-fix"}}`
			archive := campaignArchive(t, map[string]string{"catalog/repo-assist/cao.json": declaration})
			cmd := nativeSetupTestCommand()
			cmd.Flags().String("target", "other/target", "")
			cmd.Flags().String("campaign", "", "")
			cmd.Flags().Bool("wait", wait, "")
			gitCalls, ghCalls := []string{}, []string{}
			cmd.SetContext(context.WithValue(cmd.Context(), nativeSetupExecKey{}, nativeSetupExecFunc(func(_ *cobra.Command, name string, input io.Reader, args ...string) (string, error) {
				if name != "git" || input != nil {
					t.Fatalf("unexpected runtime %s", name)
				}
				call := strings.Join(args, " ")
				gitCalls = append(gitCalls, call)
				switch call {
				case "rev-parse --show-toplevel":
					return root, nil
				case "rev-parse --verify HEAD":
					return revision, nil
				case "branch --show-current":
					return "main", nil
				case "status --porcelain=v1 --untracked-files=all":
					if scenario == "retired-launcher" {
						return " M .github/workflows/cao.json\n?? repo-assist/cao.json\n D cao.sh\n", nil
					}
					return " M .github/workflows/cao.json\n?? repo-assist/cao.json\n", nil
				case "add -- .github activity dashboard repo-assist .gitattributes .vscode/settings.json", "diff --cached --check", "push --set-upstream origin HEAD":
					if strings.HasPrefix(call, "add ") && scenario == "retired-launcher" {
						t.Fatal("retired launcher deletion was not staged")
					}
					return "", nil
				case "add -- .github activity dashboard repo-assist .gitattributes .vscode/settings.json cao.sh":
					if scenario != "retired-launcher" {
						t.Fatal("fresh installation staged a nonexistent launcher")
					}
					return "", nil
				default:
					if strings.HasPrefix(call, "-c user.name=operator -c user.email=123+operator@users.noreply.github.com commit --no-gpg-sign -m ") {
						return "", nil
					}
					t.Fatalf("unexpected git operation: %s", call)
					return "", nil
				}
			})))
			run := func(id int, title string) string {
				data, _ := json.Marshal(map[string]any{"databaseId": id, "displayTitle": title, "status": "completed", "conclusion": "success", "createdAt": time.Now().UTC().Format(time.RFC3339), "updatedAt": time.Now().UTC().Format(time.RFC3339), "url": "https://example.test/run"})
				return string(data)
			}
			gh := func(_ context.Context, args ...string) (string, string, error) {
				call := strings.Join(args, " ")
				ghCalls = append(ghCalls, call)
				switch {
				case call == "repo view --json nameWithOwner,visibility":
					return `{"nameWithOwner":"org/control","visibility":"PRIVATE"}`, "", nil
				case call == "api repos/org/control --jq .default_branch":
					return "main", "", nil
				case call == "api user":
					return `{"login":"operator","id":123}`, "", nil
				case call == "repo view other/target --json nameWithOwner,visibility":
					return `{"nameWithOwner":"other/target","visibility":"PUBLIC"}`, "", nil
				case strings.HasPrefix(call, "aw add "):
					if call != "aw add githubnext/gh-cao/repo-assist@"+revision {
						t.Fatalf("default campaign was not pinned to root revision: %s", call)
					}
					writeTestFile(t, ".github/aw/packages/repo-assist.json", `{"package":"githubnext/gh-cao/repo-assist","resolvedCommit":"`+revision+`"}`)
					return "", "", nil
				case call == "api --hostname github.com /repos/githubnext/gh-cao/tarball/"+revision:
					return archive, "", nil
				case call == "aw compile --strict --no-check-update --schedule-seed githubnext/gh-cao":
					return "", "", nil
				case call == "api repos/org/control/pages":
					return `{"build_type":"workflow","public":true,"html_url":"https://org.github.io/control"}`, "", nil
				case call == "variable set GH_AW_GITHUB_AUTH_MODE --repo org/control --body workflow-token":
					return "", "", nil
				case strings.HasPrefix(call, "workflow "):
					return "", "", nil
				case strings.HasPrefix(call, "run list "):
					switch {
					case strings.Contains(call, "--workflow repo-assist.lock.yml"):
						return "[" + run(22, "Review other/target") + "]", "", nil
					case strings.Contains(call, "--workflow repo-assist-maintenance.lock.yml"):
						return "[" + run(23, "Maintain other/target") + "]", "", nil
					case strings.Contains(call, "--workflow cao-activity.yml"):
						if strings.HasSuffix(call, "--limit 1") && scenario == "different-latest" {
							return "[" + run(26, "newer collection") + "]", "", nil
						}
						return "[" + run(24, "quickstart-22") + "]", "", nil
					case strings.Contains(call, "--workflow cao-dashboard.yml"):
						return "[" + run(25, "Dashboard") + "]", "", nil
					}
				case strings.HasPrefix(call, "run view "):
					switch args[2] {
					case "22":
						return run(22, "Review other/target"), "", nil
					case "23":
						return run(23, "Maintain other/target"), "", nil
					case "24":
						return run(24, "quickstart-22"), "", nil
					case "25":
						return run(25, "Dashboard"), "", nil
					}
				case strings.HasPrefix(call, "run download 24 ") || strings.HasPrefix(call, "run download 26 "):
					if scenario == "artifact" {
						return "", "missing artifact", errors.New("missing")
					}
					dir := filepath.Join(args[len(args)-1], "gh-aw-logs-shards")
					if err := os.MkdirAll(dir, 0o700); err != nil {
						t.Fatal(err)
					}
					record := `{"schema_version":2,"kind":"workflow_runs","request":{"repository":"org/control"},"payload":[{"databaseId":22,"workflowName":"repo-assist","updatedAt":"2026-01-01T00:01:00Z"}]}`
					switch scenario {
					case "empty":
						record = ""
					case "malformed":
						record = "not-json"
					}
					if err := os.WriteFile(filepath.Join(dir, "org.jsonl"), []byte(record+"\n"), 0o600); err != nil {
						t.Fatal(err)
					}
					return "", "", nil
				}
				t.Fatalf("unexpected gh operation: %s", call)
				return "", "", nil
			}
			result, err := nativeQuickstartInstall(cmd, gh)
			if scenario == "artifact" || scenario == "empty" || scenario == "malformed" {
				want := "CAO Activity completed without a data-bearing snapshot: https://example.test/run"
				if scenario == "malformed" {
					want = "gh-aw JSONL line 1 must contain valid JSON"
				}
				if err == nil || err.Error() != want || result != nil {
					t.Fatalf("unexpected Activity audit failure result: result=%v err=%v, want %s", result, err, want)
				}
				if !nativeQuickstartContains(ghCalls, "workflow disable repo-assist.lock.yml --repo org/control") || nativeQuickstartContains(ghCalls, "workflow enable repo-assist.lock.yml --repo org/control") {
					t.Fatalf("Activity failure did not leave schedules paused: %v", ghCalls)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result["paused"] != true || result["targetRepository"] != "other/target" {
				t.Fatalf("wrong install result: %#v", result)
			}
			if !wait && (result["step"] != "install" || result["status"] != "installed") {
				t.Fatalf("wrong install stage result: %#v", result)
			}
			if wait && nativeSetupMap(result["activity"])["uniqueRuns"] != 1 {
				t.Fatalf("--wait did not verify collected evidence: %#v", result)
			}
			if scenario == "different-latest" && nativeSetupMap(result["activity"])["runId"] != json.Number("24") {
				t.Fatalf("--wait must expose the dispatched Activity run ID even when the latest artifact differs: %v", result)
			}
			for _, call := range ghCalls {
				if !wait && strings.HasPrefix(call, "workflow run ") {
					t.Fatalf("install dispatched work without --wait: %s", call)
				}
			}
			if !nativeQuickstartContains(gitCalls, "push --set-upstream origin HEAD") {
				t.Fatal("install did not push its bounded configuration")
			}
			policy, err := readPolicy()
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := nativeQuickstartCheckPolicy(policy, "org/control"); err != nil {
				t.Fatalf("installed policy is not bounded review-only: %v", err)
			}
		})
	}
}
