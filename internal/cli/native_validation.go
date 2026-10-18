package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type nativeFinding struct {
	ID          string   `json:"id"`
	Severity    string   `json:"severity"`
	Category    string   `json:"category"`
	Title       string   `json:"title"`
	Campaign    any      `json:"campaign"`
	Files       []string `json:"files"`
	Expected    any      `json:"expected"`
	Observed    any      `json:"observed"`
	Remediation any      `json:"remediation"`
	Validate    string   `json:"validate"`
}

type nativeValidationReport struct {
	ValidatorVersion string          `json:"validatorVersion"`
	Repository       string          `json:"repository"`
	GhAwVersion      any             `json:"ghAwVersion"`
	ExpectedVersion  any             `json:"expectedGhAwVersion"`
	Timestamp        string          `json:"timestamp"`
	Findings         []nativeFinding `json:"findings"`
	Summary          map[string]int  `json:"summary"`
	ExitCode         int             `json:"exitCode"`
}

func nativeNewFinding(id, severity, category, title string, files []string, expected, observed, remediation any) nativeFinding {
	if files == nil {
		files = []string{}
	}
	return nativeFinding{id, severity, category, title, nil, files, expected, observed, remediation, "gh cao validate"}
}

func nativeValidate(cmd *cobra.Command, gh ghExecutor) error {
	report := nativeValidateRepository(cmd.Context(), gh, nativeValidationExec, nativeBool(cmd, "strict-warnings"))
	if nativeBool(cmd, "json") {
		if err := printJSON(cmd, report); err != nil {
			return err
		}
	} else if _, err := fmt.Fprintln(cmd.OutOrStdout(), nativeFormatValidation(report)); err != nil {
		return err
	}
	if report.ExitCode != 0 {
		return &ExitError{Code: report.ExitCode}
	}
	return nil
}

type nativeValidationRunner func(context.Context, string, string, ...string) (string, error)

func nativeValidationExec(ctx context.Context, directory, program string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, program, args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%s: %w", strings.TrimSpace(string(output)), err)
	}
	return string(output), nil
}

func nativeValidationRepository(ctx context.Context) string {
	if repository := os.Getenv("GITHUB_REPOSITORY"); repository != "" {
		return repository
	}
	output, _ := exec.CommandContext(ctx, "git", "config", "--get", "remote.origin.url").Output()
	match := regexp.MustCompile(`(?:github\.com[:/])([^/]+/[^/]+?)(?:\.git)?$`).FindStringSubmatch(strings.TrimSpace(string(output)))
	if match != nil && repositoryPattern.MatchString(match[1]) {
		return match[1]
	}
	root, _ := os.Getwd()
	return filepath.Base(root)
}

func nativeValidateRepository(ctx context.Context, gh ghExecutor, run nativeValidationRunner, strict bool) (report nativeValidationReport) {
	report = nativeValidationReport{
		ValidatorVersion: "1", Repository: nativeValidationRepository(ctx),
		Timestamp: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Findings: []nativeFinding{},
		Summary: map[string]int{"errors": 0, "warnings": 0, "notes": 0},
	}
	defer func() {
		for _, finding := range report.Findings {
			report.Summary[finding.Severity+"s"]++
		}
		if report.ExitCode != 2 && (report.Summary["errors"] > 0 || (strict && report.Summary["warnings"] > 0)) {
			report.ExitCode = 1
		}
	}()
	fail := func(err error) nativeValidationReport {
		report.Findings = append(report.Findings, nativeNewFinding("validator-failure", "error", "infrastructure", "CAO validator failed", nil, nil, err.Error(), "Verify the checkout, runtime, and validator configuration, then rerun gh cao validate"))
		report.ExitCode = 2
		return report
	}
	if _, err := repositoryPath(policyPath); err != nil {
		return fail(err)
	}
	policySource, err := os.ReadFile(policyPath)
	if errors.Is(err, os.ErrNotExist) {
		report.Findings = append(report.Findings, nativeNewFinding("missing-cao-policy", "error", "policy", "CAO policy is missing", []string{policyPath}, "A checked-in CAO policy", policyPath+" does not exist", "gh cao init"))
		return report
	}
	if err != nil {
		return fail(err)
	}
	var raw map[string]any
	if json.Unmarshal(policySource, &raw) == nil {
		report.ExpectedVersion = raw["gh-aw-version"]
	}
	stdout, stderr, versionErr := gh(ctx, "aw", "version")
	version := versionPattern.FindString(stdout + "\n" + stderr)
	if version == "" {
		observed := strings.TrimSpace(stdout + "\n" + stderr)
		if observed == "" && versionErr != nil {
			observed = versionErr.Error()
		}
		report.Findings = append(report.Findings, nativeNewFinding("gh-aw-unavailable", "error", "compiler", "gh-aw compiler is unavailable", nil, report.ExpectedVersion, observed, "npm run install:gh-aw"))
	} else {
		report.GhAwVersion = version
		if report.ExpectedVersion != nil && report.ExpectedVersion != version {
			report.Findings = append(report.Findings, nativeNewFinding("wrong-gh-aw-compiler-version", "error", "compiler", "Installed gh-aw compiler version does not match policy", []string{policyPath}, report.ExpectedVersion, version, "npm run install:gh-aw"))
		}
		findings, err := nativeCompileCompare(ctx, run, report.ExpectedVersion)
		if err != nil {
			return fail(err)
		}
		report.Findings = append(report.Findings, findings...)
	}
	policy, err := nativeReadValidatedPolicy()
	var installed []nativeInstalledDeclaration
	if err != nil || policy["control-plane"] == nil {
		observed := "control-plane is required"
		if err != nil {
			observed = err.Error()
		}
		report.Findings = append(report.Findings, nativeNewFinding("invalid-cao-policy", "error", "policy", "CAO policy is invalid", []string{policyPath}, "Policy passes the production parser and resolver", observed, "Fix "+policyPath+" and run gh cao validate"))
	} else {
		installed, err = nativeValidationDeclarations()
		if err != nil {
			return fail(err)
		}
		report.Findings = append(report.Findings, nativeValidateDeclarations(policy, installed)...)
	}
	doctorArgs := []string{"aw", "doctor", "--json"}
	if repositoryPattern.MatchString(report.Repository) {
		doctorArgs = []string{"aw", "doctor", "--repo", report.Repository, "--dir", ".", "--json"}
	}
	if stdout, stderr, err := gh(ctx, doctorArgs...); err != nil {
		report.Findings = append(report.Findings, nativeNewFinding("doctor-check-failed", "warning", "installation", "gh-aw doctor could not verify repository setup", nil, "gh-aw doctor verifies installation and repository setup", nativeCommandDiagnostic(stdout, stderr, err), "Run gh aw doctor --dir . --json after authenticating GitHub CLI"))
	}
	report.Findings = append(report.Findings, nativeValidateEnablement(ctx, gh, installed)...)
	security, err := nativeValidateSecurity(string(policySource), installed)
	if err != nil {
		return fail(err)
	}
	report.Findings = append(report.Findings, security...)
	return report
}

func nativeCommandDiagnostic(stdout, stderr string, err error) string {
	output := strings.TrimSpace(stdout + "\n" + stderr)
	if output == "" && err != nil {
		return err.Error()
	}
	return output
}

func nativeFilesWithSuffix(directory, suffix string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), suffix) {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}

func nativeCompileCompare(ctx context.Context, run nativeValidationRunner, expected any) (findings []nativeFinding, err error) {
	findings = []nativeFinding{}
	staging, err := os.MkdirTemp(".", ".cao-validate-")
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, os.RemoveAll(staging)) }()
	workflows := filepath.Join(".github", "workflows")
	if err := nativeCopyTree(workflows, filepath.Join(staging, workflows)); err != nil {
		return nil, err
	}
	actions := filepath.Join(".github", "aw", "actions-lock.json")
	if _, err := os.Stat(actions); err == nil {
		if err := os.MkdirAll(filepath.Join(staging, ".github", "aw"), 0o755); err != nil {
			return nil, err
		}
		if err := nativeCopyTree(actions, filepath.Join(staging, actions)); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, arguments := range [][]string{
		{"init", "--quiet"}, {"add", "--all"},
		{"-c", "user.name=CAO Validator", "-c", "user.email=cao-validator@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "CAO validation snapshot"},
	} {
		if _, err := run(ctx, staging, "git", arguments...); err != nil {
			return nil, nativeErrorf("Unable to initialize isolated compiler checkout: %v", err)
		}
	}
	output, err := run(ctx, staging, "gh", "aw", "compile", "--strict", "--validate", "--show-all", "--no-check-update", "--schedule-seed", catalogRepository, "--dir", workflows)
	if err != nil {
		normalized, id := strings.ToLower(output), "compile-error"
		for _, pair := range [][2]string{{"frontmatter", "invalid-frontmatter"}, {"permission", "invalid-permissions"}, {"safe-output", "invalid-safe-output"}, {"safe output", "invalid-safe-output"}, {"trigger", "invalid-trigger"}, {"tool", "invalid-tool"}, {"workflow", "invalid-workflow"}} {
			if strings.Contains(normalized, pair[0]) {
				id = pair[1]
				break
			}
		}
		if output == "" {
			output = err.Error()
		}
		return append(findings, nativeNewFinding(id, "error", "compiler", "gh-aw strict compilation failed", nil, "Every agentic workflow compiles with strict full validation", strings.TrimSpace(output), "npm run compile:locks")), nil
	}
	sources, err := nativeFilesWithSuffix(workflows, ".md")
	if err != nil {
		return nil, err
	}
	locks, err := nativeFilesWithSuffix(workflows, ".lock.yml")
	if err != nil {
		return nil, err
	}
	expectedLocks := map[string]bool{}
	for _, source := range sources {
		lock := strings.TrimSuffix(source, ".md") + ".lock.yml"
		expectedLocks[lock] = true
		filename := filepath.Join(workflows, lock)
		files := []string{filepath.ToSlash(filename)}
		content, err := os.ReadFile(filename)
		if errors.Is(err, os.ErrNotExist) {
			findings = append(findings, nativeNewFinding("missing-generated-workflow", "error", "generated-workflows", "Generated workflow is missing", files, "A checked-in .lock.yml artifact for every workflow source", "No generated artifact exists", "npm run compile:locks"))
			continue
		}
		if err != nil {
			return nil, err
		}
		generated, err := os.ReadFile(filepath.Join(staging, filename))
		if err != nil {
			return nil, err
		}
		if string(content) != string(generated) {
			findings = append(findings, nativeNewFinding("stale-generated-workflow", "error", "generated-workflows", "Generated workflow is stale", files, "Checked-in artifact matches strict compiler output", "Compiler output differs from the checked-in artifact", "npm run compile:locks"))
		}
		var compiler any = "missing or invalid metadata"
		if match := regexp.MustCompile(`(?m)^# gh-aw-metadata: (.+)$`).FindStringSubmatch(string(content)); match != nil {
			var metadata map[string]any
			if json.Unmarshal([]byte(match[1]), &metadata) == nil && metadata["compiler_version"] != nil {
				compiler = metadata["compiler_version"]
			}
		}
		if !reflect.DeepEqual(compiler, expected) {
			findings = append(findings, nativeNewFinding("unexpected-compiler-version", "error", "compiler", "Generated workflow compiler version is unexpected", files, expected, compiler, "npm run compile:locks"))
		}
	}
	for _, lock := range locks {
		if !expectedLocks[lock] {
			filename := filepath.ToSlash(filepath.Join(workflows, lock))
			findings = append(findings, nativeNewFinding("orphaned-generated-workflow", "error", "generated-workflows", "Generated workflow has no source", []string{filename}, "Every generated workflow has a matching .md source", "No matching workflow source exists", "Remove "+filename+" after confirming its source was retired"))
		}
	}
	return findings, nil
}

type nativeInstalledDeclaration struct {
	name, file  string
	declaration *campaignDeclaration
	err         error
}

func nativeValidationDeclarations() ([]nativeInstalledDeclaration, error) {
	entries, err := os.ReadDir(".")
	if err != nil {
		return nil, err
	}
	result := []nativeInstalledDeclaration{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		file := filepath.Join(entry.Name(), "cao.json")
		if _, err := repositoryPath(file); err != nil {
			return nil, err
		}
		if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return nil, err
		}
		declaration, err := readCampaignDeclaration(entry.Name(), entry.Name())
		result = append(result, nativeInstalledDeclaration{entry.Name(), filepath.ToSlash(file), declaration, err})
	}
	return result, nil
}

func nativeValidateDeclarations(policy map[string]any, installed []nativeInstalledDeclaration) []nativeFinding {
	findings := []nativeFinding{}
	control := policy["control-plane"].(map[string]any)
	campaigns, _ := control["campaigns"].(map[string]any)
	names := map[string]bool{}
	for _, item := range installed {
		names[item.name] = true
		add := func(f nativeFinding) { f.Campaign = item.name; findings = append(findings, f) }
		if item.err != nil {
			add(nativeNewFinding("invalid-campaign-declaration", "error", "policy", "Campaign declaration is invalid", []string{item.file}, nil, item.err.Error(), "Fix "+item.file))
			continue
		}
		configured, exists := campaigns[item.name].(map[string]any)
		if !exists {
			add(nativeNewFinding("installed-campaign-absent-from-policy", "error", "policy", "Installed campaign is absent from policy", []string{item.file, policyPath}, "Every installed operational campaign is declared in policy", item.name+" is installed but undeclared", "Add "+item.name+" to "+policyPath))
		}
		for _, workflow := range nativeDeclarationWorkflows(item.declaration) {
			if _, err := os.Stat(filepath.Join(".github", "workflows", workflow+".md")); err != nil {
				add(nativeNewFinding("missing-workflow", "error", "policy", "Campaign references a missing workflow", []string{item.file}, workflow+".md is installed", "Workflow source is missing", "Reinstall or update campaign "+item.name))
			}
		}
		if exists && configured["enabled"] != false {
			workers, _ := configured["workers"].(map[string]any)
			for _, worker := range item.declaration.Workers {
				if _, exists := workers[worker.Name]; !exists {
					add(nativeNewFinding("invalid-policy-resolution", "error", "policy", "Campaign policy cannot be resolved", []string{policyPath, item.file}, nil, "unknown worker: "+item.name+"/"+worker.Name, "Reconcile "+item.file+" with "+policyPath))
					break
				}
			}
		}
	}
	missing := []string{}
	for name := range campaigns {
		if name != "dashboard" && !names[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	for _, name := range missing {
		finding := nativeNewFinding("policy-campaign-not-installed", "error", "policy", "Policy references a campaign that is not installed", []string{policyPath}, name+"/cao.json is installed", "Campaign declaration is missing", "Install "+name+" or remove its stale policy entry")
		finding.Campaign = name
		findings = append(findings, finding)
	}
	return findings
}

func nativeDeclarationWorkflows(declaration *campaignDeclaration) []string {
	result := []string{declaration.Orchestrator}
	for _, worker := range declaration.Workers {
		result = append(result, worker.Workflow)
	}
	return result
}

func nativeValidateEnablement(ctx context.Context, gh ghExecutor, installed []nativeInstalledDeclaration) []nativeFinding {
	findings := []nativeFinding{}
	stdout, stderr, err := gh(ctx, "workflow", "list", "--all", "--json", "path,state")
	var workflows []struct{ Path, State string }
	if err == nil {
		err = json.Unmarshal([]byte(stdout), &workflows)
	}
	if err != nil {
		return append(findings, nativeNewFinding("github-enablement-state-unavailable", "warning", "configuration", "GitHub workflow enablement state is unavailable", nil, "GitHub Actions workflow states can be enumerated", nativeCommandDiagnostic(stdout, stderr, err), "Authenticate gh with Actions read access and rerun gh cao validate"))
	}
	states := map[string]string{}
	for _, workflow := range workflows {
		states[strings.TrimLeft(workflow.Path, "/")] = workflow.State
	}
	for _, item := range installed {
		if item.err != nil {
			continue
		}
		paths, observed, statuses := []string{}, []string{}, []string{}
		known := map[string]bool{}
		active := 0
		for _, workflow := range nativeDeclarationWorkflows(item.declaration) {
			path := ".github/workflows/" + workflow + ".lock.yml"
			state := states[path]
			if state == "" {
				state = "unknown"
			} else if state != "unknown" {
				known[state] = true
			}
			if state == "active" {
				active++
			}
			paths, observed, statuses = append(paths, path), append(observed, workflow+": "+state), append(statuses, state)
		}
		paused := len(statuses) > 1 && statuses[0] == "disabled_manually" && active == len(statuses)-1
		if paused {
			finding := nativeNewFinding("campaign-orchestrator-paused", "note", "configuration", "Campaign orchestration is paused", paths, "A manually paused orchestrator does not start new work; active workers may finish dispatched work", strings.Join(observed, ", "), "Leave orchestration paused until another run is intended; enabling the campaign also resumes its schedule")
			finding.Campaign = item.name
			findings = append(findings, finding)
		} else if len(known) > 1 {
			action := "disable"
			if active*2 >= len(statuses) {
				action = "enable"
			}
			finding := nativeNewFinding("campaign-partially-disabled", "warning", "configuration", "Campaign workflows have inconsistent enablement", paths, "All campaign workflows share one enablement state", strings.Join(observed, ", "), "gh cao campaigns "+action+" "+item.name)
			finding.Campaign = item.name
			findings = append(findings, finding)
		}
	}
	return findings
}

func nativeValidateSecurity(policySource string, installed []nativeInstalledDeclaration) ([]nativeFinding, error) {
	findings := []nativeFinding{}
	directory := filepath.Join(".github", "workflows")
	files, err := nativeFilesWithSuffix(directory, ".yml")
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if strings.HasSuffix(file, ".lock.yml") {
			continue
		}
		filename := filepath.ToSlash(filepath.Join(directory, file))
		content, err := os.ReadFile(filename)
		if err != nil {
			return nil, err
		}
		if regexp.MustCompile(`\bpull_request_target\s*:`).Match(content) {
			findings = append(findings, nativeNewFinding("unsafe-pull-request-target", "error", "security", "Workflow uses pull_request_target", []string{filename}, "Untrusted pull request code never runs with base-repository authority", "pull_request_target trigger is configured", "Replace pull_request_target with a least-privilege pull_request design"))
		}
		for _, match := range regexp.MustCompile(`(?m)^\s*(?:-\s*)?uses:\s*([^/\s]+/[^@\s]+)@([^\s#]+)([^\r\n]*)`).FindAllStringSubmatch(string(content), -1) {
			if match[1] == catalogRepository+"/.github/workflows/cao-package-publish.yml" && match[2] == "main" && strings.TrimSpace(match[3]) == "# zizmor: ignore[unpinned-uses] protected default-branch publisher" {
				continue
			}
			if !commitPattern.MatchString(match[2]) {
				findings = append(findings, nativeNewFinding("unpinned-third-party-action", "error", "security", "Workflow uses an unpinned third-party Action", []string{filename}, "Third-party Actions are pinned to a full commit SHA", match[1]+"@"+match[2], "Pin "+match[1]+" to a reviewed full commit SHA"))
			}
		}
	}
	if regexp.MustCompile(`(?:ghp_|github_pat_|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)`).MatchString(policySource) {
		findings = append(findings, nativeNewFinding("credential-in-policy", "error", "security", "CAO policy appears to contain credential material", []string{policyPath}, "Policy contains secret names only; values remain in Actions secrets", "A credential-like value appears in policy", "Revoke the credential and replace it with an Actions secret reference"))
	}
	for _, item := range installed {
		if item.err != nil {
			continue
		}
		for index, workflow := range nativeDeclarationWorkflows(item.declaration) {
			filename := ".github/workflows/" + workflow + ".md"
			content, err := os.ReadFile(filename)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			frontmatter := regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---`).FindStringSubmatch(string(content))
			if frontmatter == nil {
				continue
			}
			add := func(id, title, expected, observed, remediation string) {
				finding := nativeNewFinding(id, "error", "security", title, []string{filename}, expected, observed, remediation)
				finding.Campaign = item.name
				findings = append(findings, finding)
			}
			if index != 0 && regexp.MustCompile(`(?m)^\s*dispatch-workflow\s*:`).MatchString(frontmatter[1]) {
				add("worker-can-dispatch-workflow", "Worker workflow can dispatch additional work", "Only orchestrators dispatch campaign workers", workflow+" declares dispatch-workflow", "Remove dispatch-workflow from "+filename)
			}
			if index == 0 && regexp.MustCompile(`(?m)^\s*(?:create-pull-request|push-to-branch|create-issue|add-comment)\s*:`).MatchString(frontmatter[1]) {
				add("orchestrator-can-mutate-target", "Orchestrator declares a direct mutation capability", "Orchestrators select and dispatch; workers perform target work", workflow+" declares a direct write safe output", "Move target mutation from "+workflow+" to a bounded worker")
			}
			if index == 0 && regexp.MustCompile(`(?mi)^\s+(?:token|password|private[_-]key|credential)\s*:`).MatchString(frontmatter[1]) {
				add("credential-in-dispatch-envelope", "Orchestrator dispatch input can carry credentials", "Dispatch envelopes contain no credentials", workflow+" declares a credential-like input", "Remove the credential input and use repository Actions secrets")
			}
		}
	}
	return findings, nil
}

func nativeFormatValidation(report nativeValidationReport) string {
	lines := []string{"CAO validation"}
	for _, group := range []struct {
		label      string
		categories []string
	}{
		{"Policy", []string{"policy"}}, {"gh-aw compiler", []string{"compiler", "installation"}},
		{"Generated workflows", []string{"generated-workflows"}}, {"Campaign enablement", []string{"configuration"}},
		{"Security", []string{"security"}}, {"Validator infrastructure", []string{"infrastructure"}},
	} {
		symbol := "✓"
		for _, finding := range report.Findings {
			if nativeContains(group.categories, finding.Category) {
				if finding.Severity == "error" {
					symbol = "✗"
					break
				}
				if finding.Severity == "warning" {
					symbol = "⚠"
				}
			}
		}
		lines = append(lines, symbol+" "+group.label)
	}
	for _, finding := range report.Findings {
		lines = append(lines, "  "+finding.Severity+": "+finding.ID+": "+finding.Title)
		if finding.Observed != nil && finding.Observed != "" {
			lines = append(lines, fmt.Sprintf("    %v", finding.Observed))
		}
		if finding.Remediation != nil && finding.Remediation != "" {
			lines = append(lines, fmt.Sprintf("    Remediation: %v", finding.Remediation))
		}
	}
	plural := func(count int, word string) string {
		if count != 1 {
			word += "s"
		}
		return fmt.Sprintf("%d %s", count, word)
	}
	lines = append(lines, plural(report.Summary["errors"], "error")+", "+plural(report.Summary["warnings"], "warning"))
	return strings.Join(lines, "\n")
}
