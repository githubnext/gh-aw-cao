package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	nativeQuickstartOrchestrator = "repo-assist.lock.yml"
	nativeQuickstartWorker       = "repo-assist-maintenance.lock.yml"
	nativeQuickstartActivity     = "cao-activity.yml"
	nativeQuickstartDashboard    = "cao-dashboard.yml"
)

var nativeQuickstartDirectories = []string{".github", "activity", "dashboard", "repo-assist"}
var nativeQuickstartPaths = []string{".github", "activity", "dashboard", "repo-assist", ".gitattributes", ".vscode/settings.json"}

func nativeQuickstartPause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func nativeQuickstartGit(cmd *cobra.Command, args ...string) (string, error) {
	out, err := nativeSetupExec(cmd, "git", nil, args...)
	return strings.TrimSpace(out), err
}

func nativeQuickstart(cmd *cobra.Command, gh ghExecutor) error {
	if err := validateQuickstart(cmd, nil); err != nil {
		return err
	}
	step := nativeSetupFlag(cmd, "step")
	if step == "" {
		step = "install"
	}
	var result map[string]any
	var err error
	if step == "install" {
		result, err = nativeQuickstartInstall(cmd, gh)
	} else {
		result, err = nativeQuickstartStage(cmd, gh, step)
	}
	if err != nil {
		return err
	}
	if nativeSetupBool(cmd, "json") {
		return printJSON(cmd, result)
	}
	if step, ok := result["step"].(string); ok {
		if _, err := fmt.Fprintf(cmd.OutOrStdout(), "CAO quickstart %s: %s.\n%s\nControl repository: https://github.com/%s (default branch: %s)\nTarget: https://github.com/%s\n",
			step, result["status"], result["context"], result["controlRepository"], result["branch"], result["targetRepository"]); err != nil {
			return err
		}
		for _, item := range []struct{ field, label string }{{"actionsUrl", "Actions"}, {"inspectCommand", "Inspect"}, {"checkpoint", "Before continuing"}, {"nextCommand", "Next"}} {
			if value, ok := result[item.field].(string); ok && value != "" {
				if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%s: %s\n", item.label, value); err != nil {
					return err
				}
			}
		}
		if dashboard := nativeSetupMap(result["dashboard"]); dashboard["url"] != nil {
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "Dashboard: %s\n", dashboard["url"]); err != nil {
				return err
			}
		}
		return nil
	}
	dashboard, activity, assist := nativeSetupMap(result["dashboard"]), nativeSetupMap(result["activity"]), nativeSetupMap(result["repoAssist"])
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "CAO quickstart complete.\nDashboard: %s\nTarget: https://github.com/%s\nRepo Assist: %s (%s)\nRepo Assist is paused; re-enable explicitly for further runs and its six-hour schedule.\nActivity: %s (%v collected runs)\nControl repository: https://github.com/%s\n",
		dashboard["url"], result["targetRepository"], assist["url"], assist["conclusion"], activity["url"], activity["uniqueRuns"], result["controlRepository"])
	return err
}

func nativeQuickstartAssertRoot(cmd *cobra.Command) error {
	root, err := nativeQuickstartGit(cmd, "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	if absolute != cwd {
		return errors.New("run CAO quickstart from the root of the control repository")
	}
	return nil
}

func nativeQuickstartCheckPaths(status string, initial bool) error {
	for _, line := range strings.Split(status, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if len(line) < 4 {
			return errors.New("git returned invalid status data")
		}
		if initial && line[0] != ' ' && line[0] != '?' {
			return errors.New("CAO quickstart refuses pre-staged changes; unstage them and retry")
		}
		path := strings.TrimSpace(line[3:])
		if _, after, ok := strings.Cut(path, " -> "); ok {
			path = after
		}
		if strings.HasPrefix(path, `"`) {
			unquoted, err := strconv.Unquote(path)
			if err != nil {
				return errors.New("git returned invalid quoted status path")
			}
			path = unquoted
		}
		allowed := line == " D cao.sh"
		for _, candidate := range nativeQuickstartPaths {
			allowed = allowed || path == candidate
		}
		for _, directory := range nativeQuickstartDirectories {
			allowed = allowed || strings.HasPrefix(path, directory+"/")
		}
		if !allowed {
			return fmt.Errorf("quickstart refuses to commit unrelated path: %s", path)
		}
	}
	return nil
}

// Git status is intentionally not TrimSpace'd: its first column is the index
// status and leading spaces are part of the safety contract.
func nativeQuickstartStatus(cmd *cobra.Command) (string, error) {
	return nativeSetupExec(cmd, "git", nil, "status", "--porcelain=v1", "--untracked-files=all")
}

func nativeQuickstartInstall(cmd *cobra.Command, gh ghExecutor) (map[string]any, error) {
	if err := nativeQuickstartAssertRoot(cmd); err != nil {
		return nil, err
	}
	_, headErr := nativeQuickstartGit(cmd, "rev-parse", "--verify", "HEAD")
	var repository nativeSetupRepository
	if err := nativeSetupJSON(cmd, gh, &repository, "repo", "view", "--json", "nameWithOwner,visibility"); err != nil {
		return nil, err
	}
	if !repositoryPattern.MatchString(repository.Repository) {
		return nil, errors.New("unable to resolve the control repository")
	}
	visibility := strings.ToUpper(repository.Visibility)
	if visibility != "PUBLIC" && visibility != "PRIVATE" && visibility != "INTERNAL" {
		return nil, errors.New("unable to resolve the control repository visibility")
	}
	repo := repository.Repository
	branch, err := nativeSetupGH(cmd, gh, "api", "repos/"+repo, "--jq", ".default_branch")
	if err != nil {
		return nil, err
	}
	if branch == "" {
		branch = "main"
	}
	if headErr == nil {
		current, err := nativeQuickstartGit(cmd, "branch", "--show-current")
		if err != nil {
			return nil, err
		}
		if current != branch {
			return nil, fmt.Errorf("CAO quickstart requires the checked-out default branch %s", branch)
		}
	}
	status, err := nativeQuickstartStatus(cmd)
	if err != nil {
		return nil, err
	}
	if err := nativeQuickstartCheckPaths(status, true); err != nil {
		return nil, err
	}
	var user struct {
		Login string
		ID    json.Number
	}
	if err := nativeSetupJSON(cmd, gh, &user, "api", "user"); err != nil {
		return nil, err
	}
	userID, idErr := strconv.ParseInt(user.ID.String(), 10, 64)
	if !nativeOwner.MatchString(user.Login) || idErr != nil || userID < 0 || userID > 9007199254740991 {
		return nil, errors.New("unable to resolve the signed-in GitHub user for the quickstart commit")
	}
	target, err := nativeSetupInspect(cmd, gh, nativeSetupFlag(cmd, "target"))
	if err != nil {
		return nil, err
	}
	if !repositoryPattern.MatchString(target.Repository) || target.Visibility != "public" {
		return nil, errors.New("quickstart target must be an accessible public repository")
	}
	campaignSpec := nativeSetupFlag(cmd, "campaign")
	if campaignSpec == "" {
		revision, err := installedCampaignRevision("root")
		if err != nil {
			return nil, err
		}
		campaignSpec = catalogRepository + "/repo-assist@" + revision
	}
	guide := nativeQuickstartGuide(repo, target.Repository, branch, campaignSpec, visibility, nativeSetupBool(cmd, "wait"))
	for _, stage := range guide {
		if err := nativeSetupNote(cmd, "%s\n%s\n", stage["title"], strings.Join(stage["details"].([]string), "\n")); err != nil {
			return nil, err
		}
	}
	// installCampaign is the canonical native materializer; it neither grants
	// new scope nor enables workers. Quickstart grants only the contract below.
	if _, err := installCampaign(cmd.Context(), gh, campaignSpec, nil); err != nil {
		return nil, err
	}
	if _, err := nativeSetupGH(cmd, gh, "aw", "compile", "--strict", "--no-check-update", "--schedule-seed", catalogRepository); err != nil {
		return nil, err
	}
	policy, err := readPolicy()
	if err != nil {
		return nil, err
	}
	if err := nativeQuickstartConfigurePolicy(policy, repo, target.Repository); err != nil {
		return nil, err
	}
	if err := writePolicy(policy, false); err != nil {
		return nil, err
	}
	if err := nativeValidatePolicy(policy); err != nil {
		return nil, err
	}
	pages, err := nativeSetupConfigurePages(cmd, gh, repo)
	if err != nil {
		return nil, err
	}
	if !pages.Public {
		return nil, errors.New("CAO quickstart requires public GitHub Pages; use setup for a private dashboard profile")
	}
	if _, err := nativeSetupGH(cmd, gh, "variable", "set", "GH_AW_GITHUB_AUTH_MODE", "--repo", repo, "--body", "workflow-token"); err != nil {
		return nil, err
	}
	status, err = nativeQuickstartStatus(cmd)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(status) == "" {
		return nil, errors.New("quickstart produced no files to commit")
	}
	if err := nativeQuickstartCheckPaths(status, false); err != nil {
		return nil, err
	}
	stagePaths := append([]string{"add", "--"}, nativeQuickstartPaths...)
	if strings.Contains("\n"+status+"\n", "\n D cao.sh\n") {
		stagePaths = append(stagePaths, "cao.sh")
	}
	if _, err := nativeQuickstartGit(cmd, stagePaths...); err != nil {
		return nil, err
	}
	if _, err := nativeQuickstartGit(cmd, "diff", "--cached", "--check"); err != nil {
		return nil, err
	}
	if headErr != nil {
		if _, err := nativeQuickstartGit(cmd, "branch", "-M", branch); err != nil {
			return nil, err
		}
	}
	if _, err := nativeQuickstartGit(cmd, "-c", "user.name="+user.Login, "-c", "user.email="+user.ID.String()+"+"+user.Login+"@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", "Set up Central Agentic Ops quickstart"); err != nil {
		return nil, err
	}
	if _, err := nativeQuickstartGit(cmd, "push", "--set-upstream", "origin", "HEAD"); err != nil {
		return nil, err
	}
	if !nativeSetupBool(cmd, "wait") {
		if _, err := nativeSetupGH(cmd, gh, "workflow", "disable", nativeQuickstartOrchestrator, "--repo", repo); err != nil {
			return nil, err
		}
		return map[string]any{
			"command": "quickstart", "step": "install", "status": "installed",
			"controlRepository": repo, "branch": branch, "targetRepository": target.Repository,
			"paused": true, "guide": guide,
			"checkpoint":  "Open " + policyPath + " and confirm the target, review mode, maintenance-only workers, and control-only Activity scope. Inspect installed workflows before requesting a run.",
			"context":     "Installed review-only maintenance and public dashboard infrastructure. No work was dispatched. Repo Assist schedules are paused; the next stage explicitly requests one review.",
			"nextCommand": "gh cao quickstart --step run",
		}, nil
	}
	result, err := nativeQuickstartWait(cmd, gh, repo, branch, target.Repository, pages)
	if err != nil {
		return nil, err
	}
	result["guide"] = guide
	return result, nil
}

func nativeQuickstartConfigurePolicy(policy map[string]any, controlRepo, target string) error {
	control := nativeSetupMap(policy["control-plane"])
	campaigns := nativeSetupMap(control["campaigns"])
	campaign := nativeSetupMap(campaigns["repo-assist"])
	workers := nativeSetupMap(campaign["workers"])
	if nativeSetupMap(workers["maintenance"])["workflow"] != "repo-assist-maintenance" {
		return nativeErrorf("Repo Assist did not install its maintenance worker declaration")
	}
	control["scope"] = map[string]any{
		"allowed-owners":       nativeSetupUnique([]string{strings.Split(controlRepo, "/")[0], strings.Split(target, "/")[0]}, false),
		"allowed-repositories": nativeSetupUnique([]string{controlRepo, target}, false),
	}
	control["activity"] = map[string]any{"repositories": []string{controlRepo}}
	campaign["icon"], campaign["enabled"], campaign["mode"] = "gear", true, "review"
	campaign["max-repositories"], campaign["rollout-percent"] = 1, 100
	campaign["targets"] = map[string]any{target: map[string]any{"mode": "review"}}
	for name, value := range workers {
		worker := nativeSetupMap(value)
		if worker == nil {
			return nativeErrorf("Repo Assist worker %s must be an object", name)
		}
		worker["enabled"], worker["max-mode"] = name == "maintenance", "review"
	}
	return nil
}

func nativeQuickstartGuide(repo, target, branch, source, visibility string, wait bool) []map[string]any {
	last := "Publish configuration and stop before campaign execution"
	if wait {
		last = "Publish configuration and continue the explicit --wait flow"
	}
	return []map[string]any{
		{"title": "1/5 · Understand the repositories and selected source", "details": []string{
			"Control repository: " + repo + " (" + strings.ToLower(visibility) + "), default branch: " + branch + ".",
			"CAO workflows, policy and review outputs live in the control repository. A public control repository exposes those records publicly.",
			"Target: " + target + " (public; explicitly selected). The target is read and never modified by this review-only campaign.",
			"Repo Assist package: " + source + ". The default uses the installed root CAO revision.",
		}},
		{"title": "2/5 · Install the campaign components", "details": []string{
			"The verified root installation supplies activity/, dashboard/ and shared control code.",
			"Core: cao-validate.yml checks configuration; cao-activity.yml collects evidence; cao-dashboard.yml publishes it.",
			"Repo Assist adds repo-assist.lock.yml and repo-assist-maintenance.lock.yml. Issue triage, issue fix and PR upkeep workers remain disabled.",
		}},
		{"title": "3/5 · Set the exact review-only authority", "details": []string{
			"Policy: " + policyPath + ". This persistent non-secret rollout policy is not a credential store.",
			"Global scope: " + strings.Join(nativeSetupUnique([]string{repo, target}, false), ", ") + ".",
			"Repo Assist target: " + target + "; mode: review; maximum repositories: 1; rollout: 100% of this exact target.",
			"Only maintenance is enabled, capped at review. Activity collection scope: " + repo + " only.",
			"Review issues and downloadable patch bundles stay in " + repo + ". Applying a proposal is optional.",
		}},
		{"title": "4/5 · Connect authentication and public dashboard hosting", "details": []string{
			"Set GH_AW_GITHUB_AUTH_MODE=workflow-token. Use repository GITHUB_TOKEN; no GitHub App or PAT is configured.",
			"GitHub Pages uses GitHub Actions. The dashboard and published evidence are PUBLIC even if the control repository is private.",
			"Pages configuration is not verified deployment; the dashboard stage checks evidence and the deploy job.",
		}},
		{"title": "5/5 · " + last, "details": []string{
			"Stage and commit only: " + strings.Join(nativeQuickstartPaths, ", ") + ". Commit with the signed-in user's noreply identity; push origin/" + branch + ".",
			"Without --wait, pause Repo Assist after pushing and do not dispatch Repo Assist or Activity.",
			"Explicit --wait dispatches Repo Assist, pauses its schedule, collects Activity, and waits for deployment.",
			"Normal Activity push/schedule triggers remain active. --step run enables one dispatch then pauses it; otherwise re-enabling resumes the six-hour schedule.",
		}},
	}
}

type nativeQuickstartContext struct {
	Repository, Branch, Target string
	DashboardDeploy            bool
}

func nativeQuickstartInstalled(cmd *cobra.Command, gh ghExecutor) (nativeQuickstartContext, error) {
	result := nativeQuickstartContext{}
	if err := nativeQuickstartAssertRoot(cmd); err != nil {
		return result, err
	}
	var repo nativeSetupRepository
	if err := nativeSetupJSON(cmd, gh, &repo, "repo", "view", "--json", "nameWithOwner,visibility"); err != nil {
		return result, err
	}
	if !repositoryPattern.MatchString(repo.Repository) {
		return result, errors.New("unable to resolve the control repository")
	}
	result.Repository = repo.Repository
	branch, err := nativeSetupGH(cmd, gh, "api", "repos/"+repo.Repository, "--jq", ".default_branch")
	if err != nil {
		return result, err
	}
	current, err := nativeQuickstartGit(cmd, "branch", "--show-current")
	if err != nil {
		return result, err
	}
	if branch == "" || branch != current {
		return result, fmt.Errorf("CAO quickstart requires the checked-out default branch %s", branch)
	}
	result.Branch = branch
	head, err := nativeQuickstartGit(cmd, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return result, err
	}
	remote, err := nativeSetupGH(cmd, gh, "api", "repos/"+repo.Repository+"/commits/"+url.PathEscape(branch), "--jq", ".sha")
	if err != nil {
		return result, err
	}
	if len(head) < 40 || len(head) > 64 || !regexpQuickstartCommit(head) || head != remote {
		return result, errors.New("CAO quickstart requires the pushed default-branch revision; synchronize your checkout first")
	}
	if _, err := nativeQuickstartGit(cmd, "diff", "--exit-code", "HEAD", "--", policyPath, ".github/workflows"); err != nil {
		return result, err
	}
	if _, err := nativeQuickstartGit(cmd, "ls-files", "--error-unmatch", "--", policyPath); err != nil {
		return result, err
	}
	policy, err := nativeReadValidatedPolicy()
	if err != nil {
		return result, err
	}
	target, deploy, err := nativeQuickstartCheckPolicy(policy, repo.Repository)
	if err != nil {
		return result, err
	}
	result.Target, result.DashboardDeploy = target, deploy
	selected, err := nativeSetupInspect(cmd, gh, target)
	if err != nil {
		return result, err
	}
	if selected.Repository != target || selected.Visibility != "public" {
		return result, errors.New("quickstart target must remain an accessible public repository")
	}
	return result, nil
}

func regexpQuickstartCommit(value string) bool {
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

func nativeQuickstartCheckPolicy(policy map[string]any, repo string) (string, bool, error) {
	control := nativeSetupMap(policy["control-plane"])
	campaigns := nativeSetupMap(control["campaigns"])
	campaign := nativeSetupMap(campaigns["repo-assist"])
	targets := nativeSetupMap(campaign["targets"])
	workers := nativeSetupMap(campaign["workers"])
	maintenance := nativeSetupMap(workers["maintenance"])
	number := func(value any, expected string) bool { return fmt.Sprint(value) == expected }
	if campaign["enabled"] != true || campaign["mode"] != "review" || !number(campaign["max-repositories"], "1") || !number(campaign["rollout-percent"], "100") || len(targets) != 1 || maintenance["enabled"] != true || maintenance["max-mode"] != "review" || maintenance["workflow"] != "repo-assist-maintenance" {
		return "", false, errors.New("quickstart requires exactly one enabled review-only Repo Assist maintenance target and bounded rollout policy")
	}
	for name, worker := range workers {
		if name != "maintenance" && nativeSetupMap(worker)["enabled"] != false {
			return "", false, errors.New("quickstart requires all non-maintenance workers disabled")
		}
	}
	target := ""
	for name, value := range targets {
		if !repositoryPattern.MatchString(name) || nativeSetupMap(value)["mode"] != "review" {
			return "", false, errors.New("quickstart requires an exact review target")
		}
		target = name
	}
	scope := nativeSetupMap(control["scope"])
	repos, _ := nativeSetupStrings(scope["allowed-repositories"])
	owners, _ := nativeSetupStrings(scope["allowed-owners"])
	authorized := func(repo string) bool {
		return nativeQuickstartContains(repos, repo) && nativeQuickstartContains(owners, strings.Split(repo, "/")[0])
	}
	activity, _ := nativeSetupStrings(nativeSetupMap(control["activity"])["repositories"])
	if !authorized(repo) || !authorized(target) || control["mode"] == "live" || len(activity) != 1 || activity[0] != repo {
		return "", false, errors.New("quickstart policy must authorize the exact review target and collect only the control repository")
	}
	return target, nativeSetupMap(campaigns["dashboard"])["deploy"] != false, nil
}

func nativeQuickstartContains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func nativeQuickstartDispatch(cmd *cobra.Command, gh ghExecutor, repo, branch, workflow string, fields []string, attempts int) error {
	args := []string{"workflow", "run", workflow, "--repo", repo, "--ref", branch}
	for _, field := range fields {
		args = append(args, "--raw-field", field)
	}
	var err error
	for i := 0; i < attempts; i++ {
		if _, err = nativeSetupGH(cmd, gh, args...); err == nil {
			return nil
		}
		if i+1 < attempts {
			if waitErr := nativeQuickstartPause(cmd.Context(), 2*time.Second); waitErr != nil {
				return waitErr
			}
		}
	}
	return err
}

func nativeQuickstartDispatchReview(cmd *cobra.Command, gh ghExecutor, repo, branch, target string, enable bool, attempts int) (err error) {
	defer func() {
		// Cancellation must not prevent the attempt to pause a schedule that
		// this command may just have enabled.
		pauseContext, cancel := context.WithTimeout(context.WithoutCancel(cmd.Context()), 30*time.Second)
		defer cancel()
		pauseCommand := *cmd
		pauseCommand.SetContext(pauseContext)
		_, pauseErr := nativeSetupGH(&pauseCommand, gh, "workflow", "disable", nativeQuickstartOrchestrator, "--repo", repo)
		if pauseErr != nil {
			err = errors.Join(err, fmt.Errorf("pausing Repo Assist also failed: %w", pauseErr))
		}
	}()
	if enable {
		if _, err := nativeSetupGH(cmd, gh, "workflow", "enable", nativeQuickstartOrchestrator, "--repo", repo); err != nil {
			return err
		}
	}
	return nativeQuickstartDispatch(cmd, gh, repo, branch, nativeQuickstartOrchestrator, []string{
		"target_repo=" + target, "safe_output_repo=" + repo, "max_repos=1", "rollout_percent=100", "safe_output_mode=review",
	}, attempts)
}

type nativeQuickstartRun struct {
	ID         json.Number `json:"databaseId"`
	Title      string      `json:"displayTitle"`
	Status     string      `json:"status"`
	Conclusion string      `json:"conclusion"`
	Created    string      `json:"createdAt"`
	Updated    string      `json:"updatedAt"`
	URL        string      `json:"url"`
}

func nativeQuickstartRuns(cmd *cobra.Command, gh ghExecutor, repo, branch, workflow, event, created string) ([]nativeQuickstartRun, error) {
	args := []string{"run", "list", "--repo", repo}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, "--workflow", workflow)
	if event != "" {
		args = append(args, "--event", event)
	}
	if created != "" {
		args = append(args, "--created", ">="+created)
	}
	args = append(args, "--limit", "20", "--json", "databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url")
	var runs []nativeQuickstartRun
	if err := nativeSetupJSON(cmd, gh, &runs, args...); err != nil {
		return nil, err
	}
	if runs == nil {
		return nil, fmt.Errorf("invalid run list for %s", workflow)
	}
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].Created > runs[j].Created })
	return runs, nil
}

func nativeQuickstartStage(cmd *cobra.Command, gh ghExecutor, step string) (map[string]any, error) {
	context, err := nativeQuickstartInstalled(cmd, gh)
	if err != nil {
		return nil, err
	}
	repo, branch, target := context.Repository, context.Branch, context.Target
	base := map[string]any{"command": "quickstart", "step": step, "controlRepository": repo, "branch": branch, "targetRepository": target}
	server := strings.TrimRight(os.Getenv("GITHUB_SERVER_URL"), "/")
	if server == "" {
		server = "https://github.com"
	}
	workflowInfo := func(workflow string) {
		base["actionsUrl"] = server + "/" + repo + "/actions/workflows/" + workflow
		base["inspectCommand"] = "gh run list --repo " + repo + " --branch '" + strings.ReplaceAll(branch, "'", "'\\''") + "' --workflow " + workflow
	}
	if step == "run" {
		if err := nativeSetupNote(cmd, "Request one bounded review of %s. Outputs stay in %s; no target changes are applied.\nBudget ceiling: up to 1,250 AI credits (250 orchestration + 600 maintenance + 400 configurable output checking). A proposal is optional; no-op/incomplete is valid. Orchestrator schedules will be paused even if dispatch fails.\n", target, repo); err != nil {
			return nil, err
		}
		if err := nativeQuickstartDispatchReview(cmd, gh, repo, branch, target, true, 1); err != nil {
			return nil, err
		}
		base["status"], base["paused"] = "dispatched", true
		workflowInfo(nativeQuickstartOrchestrator)
		base["inspectCommand"] = "gh run list --repo " + repo + " --branch '" + strings.ReplaceAll(branch, "'", "'\\''") + "' --workflow " + nativeQuickstartWorker
		base["context"] = "One bounded review was requested (up to 1,250 AI credits: 250 orchestration + 600 maintenance + 400 configurable output checking). Inspect the orchestrator and maintenance proposal or no-op before collecting evidence. No target changes are applied."
		base["checkpoint"] = "Inspect the completed orchestrator and maintenance worker, then read the control review issue and artifact or its no-op/incomplete reason. Do not repeat run as a status check."
		base["nextCommand"] = "gh cao quickstart --step collect"
		return base, nil
	}
	if step == "collect" {
		if err := nativeSetupNote(cmd, "Collect completed workflow evidence from %s only; do not rerun maintenance or apply a proposal. Continue only after inspecting its completed outcome. This requests a snapshot; it is not a status check.\n", repo); err != nil {
			return nil, err
		}
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return nil, err
		}
		random[6], random[8] = random[6]&0x0f|0x40, random[8]&0x3f|0x80
		encoded := hex.EncodeToString(random)
		requestID := "quickstart-" + encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
		if err := nativeQuickstartDispatch(cmd, gh, repo, branch, nativeQuickstartActivity, []string{"request-id=" + requestID}, 1); err != nil {
			return nil, err
		}
		base["status"], base["requestId"] = "dispatched", requestID
		workflowInfo(nativeQuickstartActivity)
		base["context"] = "Activity collects workflow evidence; a successful workflow alone does not prove an accepted improvement. Inspect this snapshot before checking its dashboard deployment."
		base["checkpoint"] = "Inspect CAO Activity in Actions and its data artifact. After collection finishes, use the read-only dashboard step; do not repeat collect just to check progress."
		base["nextCommand"] = "gh cao quickstart --step dashboard"
		return base, nil
	}
	pending := func(message, workflow string) (map[string]any, error) {
		base["status"], base["context"] = "pending", message
		workflowInfo(workflow)
		base["nextCommand"] = "gh cao quickstart --step dashboard"
		base["checkpoint"] = "Inspect the linked workflow and resolve failures before retrying this read-only check. Do not restart run or collect merely to check status."
		return base, nil
	}
	activityRuns, err := nativeQuickstartRuns(cmd, gh, repo, branch, nativeQuickstartActivity, "", "")
	if err != nil {
		return nil, err
	}
	if !context.DashboardDeploy {
		return pending("Standalone Pages deployment is disabled by policy. This read-only check cannot publish a dashboard.", nativeQuickstartDashboard)
	}
	if len(activityRuns) == 0 || activityRuns[0].Status != "completed" || activityRuns[0].Conclusion != "success" {
		return pending("The latest default-branch Activity snapshot is not successfully completed. Inspect Actions, then retry this read-only check; no work was dispatched.", nativeQuickstartActivity)
	}
	activity := activityRuns[0]
	unique, err := nativeQuickstartActivityEvidence(cmd, gh, repo, activity.ID.String())
	if err != nil {
		if errors.Is(err, errNativeQuickstartNoEvidence) {
			return pending("The latest Activity snapshot has no verified data-bearing artifact. Inspect collection evidence and retry this read-only check.", nativeQuickstartActivity)
		}
		return nil, err
	}
	dashboards, err := nativeQuickstartRuns(cmd, gh, repo, branch, nativeQuickstartDashboard, "workflow_run", "")
	if err != nil {
		return nil, err
	}
	var dashboard *nativeQuickstartRun
	updated, updatedErr := time.Parse(time.RFC3339, activity.Updated)
	for i := range dashboards {
		created, createdErr := time.Parse(time.RFC3339, dashboards[i].Created)
		if updatedErr == nil && createdErr == nil && !created.Before(updated) {
			dashboard = &dashboards[i]
			break
		}
	}
	if dashboard == nil || dashboard.Status != "completed" || dashboard.Conclusion != "success" {
		return pending("A successful dashboard deployment after the latest Activity snapshot is not ready. Retry this read-only check; no new collection was dispatched.", nativeQuickstartDashboard)
	}
	var jobs struct {
		Jobs []struct{ Name, Status, Conclusion string }
	}
	if err := nativeSetupJSON(cmd, gh, &jobs, "run", "view", dashboard.ID.String(), "--repo", repo, "--json", "jobs"); err != nil {
		return nil, err
	}
	deployed := false
	for _, job := range jobs.Jobs {
		if job.Name == "deploy" && job.Status == "completed" && job.Conclusion == "success" {
			deployed = true
			break
		}
	}
	if !deployed {
		return pending("The dashboard run has no completed successful Pages deploy job. Inspect its deployment jobs and retry this read-only check.", nativeQuickstartDashboard)
	}
	var pages map[string]any
	if err := nativeSetupJSON(cmd, gh, &pages, "api", "repos/"+repo+"/pages"); err != nil {
		return nil, err
	}
	address, _ := pages["html_url"].(string)
	if address == "" || pages["public"] == false {
		return pending("No public deployed Pages URL is available yet. Inspect Pages and retry this read-only check.", nativeQuickstartDashboard)
	}
	base["status"] = "ready"
	base["context"] = "Activity contains collected runs and its subsequent dashboard workflow succeeded. Explore the evidence; operational value still requires reviewing outcomes."
	base["dashboard"] = map[string]any{"url": address, "workflowRun": dashboard.URL}
	base["activity"] = map[string]any{"url": activity.URL, "uniqueRuns": unique}
	base["checkpoint"] = "Open the dashboard, select Repo Assist, then Reports, and follow evidence to its originating run. A proposal remains optional; the orchestrator stays paused."
	base["nextCommand"] = "gh browse --repo " + repo + " --actions"
	return base, nil
}

var errNativeQuickstartNoEvidence = errors.New("activity completed without a data-bearing snapshot")

func nativeQuickstartActivityEvidence(cmd *cobra.Command, gh ghExecutor, repo, id string) (int, error) {
	return nativeQuickstartInspectActivityRun(cmd, gh, repo, id, true)
}

func nativeQuickstartInspectActivityRun(cmd *cobra.Command, gh ghExecutor, repo, id string, verify bool) (total int, err error) {
	if verify {
		var current nativeQuickstartRun
		if err := nativeSetupJSON(cmd, gh, &current, "run", "view", id, "--repo", repo, "--json", "databaseId,status,conclusion,createdAt,updatedAt,url"); err != nil {
			return 0, err
		}
		if current.ID.String() != id {
			return 0, errNativeQuickstartNoEvidence
		}
	}
	// Scratch data stays inside the checkout and is removed on every exit path.
	dir, err := os.MkdirTemp(".", ".cao-quickstart-evidence-")
	if err != nil {
		return 0, err
	}
	defer func() { err = errors.Join(err, os.RemoveAll(dir)) }()
	if _, err := nativeSetupGH(cmd, gh, "run", "download", id, "--repo", repo, "--name", "cao-activity-index", "--dir", dir); err != nil {
		return 0, errors.Join(errNativeQuickstartNoEvidence, err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "gh-aw-logs-shards"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, errNativeQuickstartNoEvidence
		}
		return 0, err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(dir, "gh-aw-logs-shards", entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return 0, nativeErrorf("Activity shard must be a regular file")
		}
		file, err := os.Open(path)
		if err != nil {
			return 0, err
		}
		count, err := nativeQuickstartCountRuns(file)
		if closeErr := file.Close(); err != nil || closeErr != nil {
			return 0, errors.Join(err, closeErr)
		}
		// Production activity-stats deduplicates within, not across, shards.
		total += count
	}
	if total < 1 {
		return 0, errNativeQuickstartNoEvidence
	}
	return total, nil
}

func nativeQuickstartFindRun(cmd *cobra.Command, gh ghExecutor, repo, workflow, event, created, title string, attempts int, required bool) (*nativeQuickstartRun, error) {
	for attempt := 0; attempt < attempts; attempt++ {
		runs, err := nativeQuickstartRuns(cmd, gh, repo, "", workflow, event, created)
		if err != nil {
			return nil, err
		}
		for _, run := range runs {
			if title == "" || strings.Contains(run.Title, title) {
				return &run, nil
			}
		}
		if attempt+1 < attempts {
			if err := nativeQuickstartPause(cmd.Context(), 2*time.Second); err != nil {
				return nil, err
			}
		}
	}
	if !required {
		return nil, nil
	}
	return nil, fmt.Errorf("timed out waiting for %s to start", workflow)
}

func nativeQuickstartWatchRun(cmd *cobra.Command, gh ghExecutor, repo string, run *nativeQuickstartRun) (*nativeQuickstartRun, error) {
	for attempt := 0; attempt < 1080; attempt++ {
		var current nativeQuickstartRun
		if err := nativeSetupJSON(cmd, gh, &current, "run", "view", run.ID.String(), "--repo", repo, "--json", "databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url"); err != nil {
			return nil, err
		}
		if current.Status == "completed" {
			return &current, nil
		}
		if attempt+1 < 1080 {
			if err := nativeQuickstartPause(cmd.Context(), 5*time.Second); err != nil {
				return nil, err
			}
		}
	}
	return nil, fmt.Errorf("timed out waiting for workflow run %s", run.URL)
}

func nativeQuickstartWait(cmd *cobra.Command, gh ghExecutor, repo, branch, target string, pages nativeSetupPages) (map[string]any, error) {
	created := time.Now().Add(-5 * time.Second).UTC().Format(time.RFC3339)
	if err := nativeQuickstartDispatchReview(cmd, gh, repo, branch, target, false, 30); err != nil {
		return nil, err
	}
	assist, err := nativeQuickstartFindRun(cmd, gh, repo, nativeQuickstartOrchestrator, "workflow_dispatch", created, target, 30, true)
	if err != nil {
		return nil, err
	}
	assist, err = nativeQuickstartWatchRun(cmd, gh, repo, assist)
	if err != nil {
		return nil, err
	}
	worker, err := nativeQuickstartFindRun(cmd, gh, repo, nativeQuickstartWorker, "workflow_dispatch", created, target, 15, false)
	if err != nil {
		return nil, err
	}
	if worker != nil {
		worker, err = nativeQuickstartWatchRun(cmd, gh, repo, worker)
		if err != nil {
			return nil, err
		}
	}
	request := "quickstart-" + assist.ID.String()
	activityCreated := time.Now().Add(-5 * time.Second).UTC().Format(time.RFC3339)
	if err := nativeQuickstartDispatch(cmd, gh, repo, branch, nativeQuickstartActivity, []string{"request-id=" + request}, 30); err != nil {
		return nil, err
	}
	activity, err := nativeQuickstartFindRun(cmd, gh, repo, nativeQuickstartActivity, "workflow_dispatch", activityCreated, request, 30, true)
	if err != nil {
		return nil, err
	}
	activity, err = nativeQuickstartWatchRun(cmd, gh, repo, activity)
	if err != nil {
		return nil, err
	}
	if activity.Conclusion != "success" {
		return nil, fmt.Errorf("CAO Activity concluded %s: %s", activity.Conclusion, activity.URL)
	}
	// Match --wait's most-recent-snapshot contract (the staged dashboard path
	// pins the exact Activity run instead).
	var latest []nativeQuickstartRun
	if err := nativeSetupJSON(cmd, gh, &latest, "run", "list", "--repo", repo, "--workflow", nativeQuickstartActivity, "--json", "databaseId,status,conclusion,createdAt,updatedAt,url", "--limit", "1"); err != nil {
		return nil, err
	}
	if len(latest) != 1 {
		return nil, nativeErrorf("CAO Activity completed without a data-bearing snapshot: %s", activity.URL)
	}
	unique, err := nativeQuickstartInspectActivityRun(cmd, gh, repo, latest[0].ID.String(), false)
	if err != nil {
		if errors.Is(err, errNativeQuickstartNoEvidence) {
			return nil, nativeErrorf("CAO Activity completed without a data-bearing snapshot: %s", activity.URL)
		}
		return nil, err
	}
	dashboard, err := nativeQuickstartFindRun(cmd, gh, repo, nativeQuickstartDashboard, "workflow_run", activityCreated, "", 30, true)
	if err != nil {
		return nil, err
	}
	dashboard, err = nativeQuickstartWatchRun(cmd, gh, repo, dashboard)
	if err != nil {
		return nil, err
	}
	if dashboard.Conclusion != "success" {
		return nil, fmt.Errorf("CAO Dashboard concluded %s: %s", dashboard.Conclusion, dashboard.URL)
	}
	var deployed map[string]any
	if err := nativeSetupJSON(cmd, gh, &deployed, "api", "repos/"+repo+"/pages"); err != nil {
		return nil, err
	}
	address, _ := deployed["html_url"].(string)
	if address == "" {
		address = pages.URL
	}
	if address == "" {
		return nil, errors.New("CAO Dashboard deployed, but GitHub returned no Pages URL")
	}
	assistResult := map[string]any{"runId": assist.ID, "url": assist.URL, "conclusion": assist.Conclusion}
	if worker != nil {
		assistResult["workerRunId"], assistResult["workerUrl"], assistResult["workerConclusion"] = worker.ID, worker.URL, worker.Conclusion
	}
	visibility := "public"
	if deployed["public"] == false {
		visibility = "private"
	}
	return map[string]any{
		"command": "quickstart", "controlRepository": repo, "targetRepository": target, "campaign": "repo-assist", "mode": "review", "paused": true,
		"dashboard":  map[string]any{"url": address, "workflowRun": dashboard.URL, "visibility": visibility},
		"repoAssist": assistResult, "activity": map[string]any{"runId": activity.ID, "url": activity.URL, "uniqueRuns": unique},
	}, nil
}
