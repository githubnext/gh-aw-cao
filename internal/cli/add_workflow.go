package cli

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/github/gh-aw/pkg/parser"
	"github.com/spf13/cobra"
)

func addWorkflowCommand(gh ghExecutor) *cobra.Command {
	var force bool
	var engine string
	cmd := &cobra.Command{
		Use:   "add WORKFLOW",
		Short: "Install and register a standalone CAO workflow",
		Long: `Install one standalone workflow with gh aw add, then register it in
.github/workflows/cao.json. New entries are review-only and limited to one
repository. Existing policy settings and repository scope are preserved.

Use a catalog name such as daily-repo-status[@REF], an explicit OWNER/REPO/PATH.md[@REF],
a GitHub blob URL, or a local .md file. Catalog names resolve to
githubnext/gh-cao/.github/workflows/, not the upstream workflows/ shorthand.
The installed workflow must import shared/control.md with role: standalone
and its exact workflow identity. Prepare the shared runtime with gh cao setup.

Review and publish the workflow, generated lock and policy together.
Interactive additions separately offer commit/push
and an opt-in first review run after publication. Both default to No.
Noninteractive and unchanged additions never publish or run.
For campaign packages use gh cao campaigns add instead.`,
		Example: `  gh cao add daily-repo-status
  gh cao add daily-repo-status@v1.2.3
  gh cao add githubnext/gh-cao/.github/workflows/daily-repo-status.md@main
  gh cao add ./my-report.md --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			spec, name, err := standaloneWorkflowSpec(args[0])
			if err != nil {
				return err
			}
			options := []string{"--dir", ".github/workflows"}
			if force {
				options = append(options, "--force")
			}
			if engine != "" {
				options = append(options, "--engine", engine)
			}
			prompt := nativeSetupGetPrompt(cmd)
			if os.Getenv("CI") != "" {
				prompt = nil
			}
			var before map[string]string
			if prompt != nil {
				before, err = workflowAddSnapshot(cmd)
				if err != nil {
					return err
				}
			}
			result, err := installStandaloneWorkflow(cmd.Context(), gh, spec, name, options)
			if err != nil {
				return err
			}
			if prompt != nil {
				if err := finishWorkflowAdd(cmd, gh, prompt, name, before, result); err != nil {
					return err
				}
			}
			return printJSON(cmd, result)
		},
	}
	cmd.Flags().BoolVarP(&force, "force", "f", false, "Overwrite installed workflow files without resetting their CAO policy")
	cmd.Flags().StringVarP(&engine, "engine", "e", "", "Override the gh-aw AI engine")
	return cmd
}

func standaloneWorkflowSpec(input string) (spec, name string, err error) {
	invalid := func() (string, string, error) {
		return "", "", errors.New("add requires a catalog workflow name or one explicit .md workflow source; use gh cao campaigns add for campaign packages")
	}
	if input == "" || strings.HasPrefix(input, "-") || strings.ContainsAny(input, "*?[]\\\r\n") {
		return invalid()
	}
	spec = input
	source := input
	if strings.HasPrefix(input, "https://") {
		location, parseErr := url.Parse(input)
		if parseErr != nil || location.Host == "" || location.User != nil || location.RawQuery != "" || location.Fragment != "" {
			return invalid()
		}
		source = location.Path
	} else if index := strings.LastIndex(input, "@"); index >= 0 {
		source = input[:index]
		if index == len(input)-1 {
			return invalid()
		}
	}
	if slugPattern.MatchString(source) || strings.HasPrefix(source, catalogRepository+"/") && strings.Count(source, "/") == 2 {
		name = path.Base(source)
		if !slugPattern.MatchString(name) {
			return invalid()
		}
		if name == "repo-status" {
			name = "daily-repo-status"
		}
		spec = catalogRepository + "/.github/workflows/" + name + ".md" + strings.TrimPrefix(input, source)
	} else {
		if !strings.HasSuffix(source, ".md") {
			return invalid()
		}
		name = strings.TrimSuffix(path.Base(source), ".md")
	}
	if !slugPattern.MatchString(name) {
		return invalid()
	}
	return spec, name, nil
}

func installStandaloneWorkflow(ctx context.Context, gh ghExecutor, spec, name string, options []string) (map[string]any, error) {
	policy, err := nativeReadValidatedPolicy()
	create := errors.Is(err, os.ErrNotExist)
	if create {
		policy, _, err = newPolicy(ctx, gh)
	}
	if err != nil {
		return nil, err
	}
	workflowPath := filepath.Join(".github", "workflows", name+".md")
	for _, destination := range []string{policyPath, workflowPath, strings.TrimSuffix(workflowPath, ".md") + ".lock.yml"} {
		if _, err := repositoryPath(destination); err != nil {
			return nil, err
		}
	}
	args := append([]string{"aw", "add", spec}, options...)
	if _, stderr, err := gh(ctx, args...); err != nil {
		return nil, commandError("gh aw add failed; CAO policy was not changed", stderr, err)
	}
	if err := pinAutoUpgradeActions(); err != nil {
		return nil, err
	}
	if _, stderr, err := gh(ctx, "aw", "compile", workflowPath, "--strict", "--schedule-seed", catalogRepository, "--no-check-update"); err != nil {
		return nil, commandError("gh aw compile failed; CAO policy was not changed (inspect installed files; prepare the shared runtime with gh cao setup)", stderr, err)
	}
	if err := verifyStandaloneWorkflow(workflowPath, name); err != nil {
		return nil, fmt.Errorf("workflow installation could not be registered; CAO policy was not changed (inspect installed files): %w", err)
	}
	// Re-read after installation so registration never replaces an install-time policy change.
	if !create {
		policy, err = nativeReadValidatedPolicy()
		if err != nil {
			return nil, err
		}
	}
	control, _ := policy["control-plane"].(map[string]any)
	if control == nil {
		control = map[string]any{}
		policy["control-plane"] = control
	}
	workflows, _ := control["workflows"].(map[string]any)
	if workflows == nil {
		workflows = map[string]any{}
		control["workflows"] = workflows
	}
	_, exists := workflows[name]
	if !exists {
		workflows[name] = map[string]any{"mode": "review", "max-mode": "review", "max-repositories": 1}
		if err := nativeValidatePolicy(policy); err != nil {
			return nil, fmt.Errorf("unable to register installed workflow: %w", err)
		}
		if err := writePolicy(policy, create); err != nil {
			return nil, fmt.Errorf("workflow installed but CAO policy could not be saved: %w", err)
		}
	}
	return map[string]any{"command": "add", "workflow": name, "policy": policyPath, "registration": workflows[name]}, nil
}

func verifyStandaloneWorkflow(workflowPath, name string) error {
	content, err := os.ReadFile(workflowPath)
	if err != nil {
		return err
	}
	frontmatter, err := parser.ExtractFrontmatterFromContent(string(content))
	if err != nil {
		return err
	}
	gate, _ := frontmatter.Frontmatter["if"].(string)
	gate = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(gate, "${{"), "}}"))
	if gate != "needs.pre_activation.outputs.cao_authorized == 'true'" {
		return fmt.Errorf("%s must retain the CAO pre-activation gate", workflowPath)
	}
	imports, _ := frontmatter.Frontmatter["imports"].([]any)
	for _, value := range imports {
		entry, _ := value.(map[string]any)
		if entry["uses"] != "shared/control.md" {
			continue
		}
		inputs, _ := entry["with"].(map[string]any)
		if inputs["role"] != "standalone" || inputs["workflow"] != name {
			return fmt.Errorf("%s must declare role: standalone and workflow: %s in its shared/control.md import", workflowPath, name)
		}
		lock := strings.TrimSuffix(workflowPath, ".md") + ".lock.yml"
		info, err := os.Stat(lock)
		if err != nil {
			return fmt.Errorf("installed workflow has no compiled lock: %w", err)
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("installed workflow has no compiled lock: %s", lock)
		}
		return nil
	}
	return fmt.Errorf("%s is not a standalone CAO workflow: missing shared/control.md import", workflowPath)
}
