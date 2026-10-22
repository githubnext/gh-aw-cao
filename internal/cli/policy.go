package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
)

const policyPath = ".github/workflows/cao.json"
const schemaURL = "https://raw.githubusercontent.com/githubnext/gh-cao/main/.github/workflows/shared/cao.schema.json"

var (
	slugPattern       = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`)
	versionPattern    = regexp.MustCompile(`\bv[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\b`)
)

func addPolicyCommands(root *cobra.Command, gh ghExecutor) {
	root.AddCommand(&cobra.Command{
		Use: "init", Short: "Create an exact, review-safe control-plane policy", Args: cobra.NoArgs,
		Long: "Create only a local exact, review-safe policy for preparation or scripting. Requires gh-aw and a GitHub checkout; does not install runtime files, configure Pages or credentials, commit, push, or execute work. For complete guided onboarding use gh cao setup; no prior init is needed.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := initializePolicy(cmd.Context(), gh)
			if err != nil {
				return err
			}
			return printJSON(cmd, result)
		},
	})
	campaigns := &cobra.Command{
		Use: "campaigns", Short: "Control campaign policy modes and workflows", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf("campaigns requires mode, enable, or disable; install with gh cao add")
		},
	}
	campaigns.AddCommand(&cobra.Command{
		Use: "mode (live|preview) CAMPAIGN...", Short: "Set campaign policy mode without widening repository scope", Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if args[0] != "live" && args[0] != "preview" {
				return fmt.Errorf("mode requires live or preview")
			}
			campaigns, err := campaignNames(args[1:])
			if err != nil {
				return err
			}
			policy, err := readPolicy()
			if err != nil {
				return err
			}
			control, _ := policy["control-plane"].(map[string]any)
			configured, _ := control["campaigns"].(map[string]any)
			for _, name := range campaigns {
				value, exists := configured[name]
				if !exists {
					return fmt.Errorf("unknown CAO campaign: %s", name)
				}
				if _, ok := value.(map[string]any); !ok {
					return fmt.Errorf("%s control-plane campaign %s must be an object", policyPath, name)
				}
			}
			mode := "review"
			if args[0] == "live" {
				mode = "live"
				checkLiveAuthentication(cmd, gh)
			}
			for _, name := range campaigns {
				configured[name].(map[string]any)["mode"] = mode
			}
			if err := writePolicy(policy, false); err != nil {
				return err
			}
			return printJSON(cmd, map[string]any{"command": "mode", "mode": args[0], "campaigns": campaigns, "policy": policyPath})
		},
	})
	for _, action := range []string{"enable", "disable"} {
		campaigns.AddCommand(&cobra.Command{
			Use: action + " CAMPAIGN...", Short: strings.ToUpper(action[:1]) + action[1:] + " every declared campaign workflow", Args: cobra.MinimumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				campaigns, err := campaignNames(args)
				if err != nil {
					return err
				}
				var workflows []string
				seen := map[string]bool{}
				for _, campaign := range campaigns {
					declared, err := campaignWorkflows(campaign)
					if err != nil {
						return err
					}
					for _, workflow := range declared {
						if !seen[workflow] {
							workflows = append(workflows, workflow)
							seen[workflow] = true
						}
					}
				}
				for _, workflow := range workflows {
					_, stderr, err := gh(cmd.Context(), "workflow", action, workflow+".lock.yml")
					if err != nil {
						return commandError("gh workflow "+action+" failed for "+workflow, stderr, err)
					}
				}
				return printJSON(cmd, map[string]any{"command": action, "campaigns": campaigns, "workflows": workflows})
			},
		})
	}
	root.AddCommand(campaigns)
}

func initializePolicy(ctx context.Context, gh ghExecutor) (map[string]any, error) {
	if _, err := os.Lstat(policyPath); err == nil {
		return nil, fmt.Errorf("%s already exists", policyPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	policy, version, err := newPolicy(ctx, gh)
	if err != nil {
		return nil, err
	}
	if err := writePolicy(policy, true); err != nil {
		return nil, err
	}
	return map[string]any{"command": "init", "policy": policyPath, "gh-aw-version": version}, nil
}

func newPolicy(ctx context.Context, gh ghExecutor) (map[string]any, string, error) {
	stdout, stderr, err := gh(ctx, "aw", "version")
	if err != nil {
		return nil, "", commandError("unable to determine gh-aw version", stderr, err)
	}
	version := versionPattern.FindString(stdout + "\n" + stderr)
	if version == "" {
		return nil, "", errors.New(`unable to determine gh-aw version from "gh aw version" output`)
	}
	stdout, stderr, err = gh(ctx, "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
	if err != nil {
		return nil, "", commandError("unable to determine control repository; run gh cao init from a GitHub repository checkout with a configured remote", stderr, err)
	}
	repository := strings.TrimSpace(stdout)
	if !repositoryPattern.MatchString(repository) {
		return nil, "", errors.New("unable to determine control repository: expected exact OWNER/REPO")
	}
	return initialPolicy(repository, version), version, nil
}

func initialPolicy(repository, version string) map[string]any {
	return map[string]any{
		"$schema": schemaURL, "version": 1, "gh-aw-version": version,
		"control-plane": map[string]any{
			"scope": map[string]any{
				"allowed-owners":       []string{strings.SplitN(repository, "/", 2)[0]},
				"allowed-repositories": []string{repository},
			},
			"marketplace": map[string]any{"registries": []any{
				map[string]any{"id": "official", "name": "Official CAO catalog", "repository": "githubnext/gh-cao", "ref": "main", "auth": map[string]string{"type": "none"}},
				map[string]any{"id": "agentics", "name": "Agentics workflows", "repository": "githubnext/agentics", "path": "workflows", "format": "workflows", "ref": "main", "auth": map[string]string{"type": "none"}},
			}},
			"campaigns": map[string]any{},
		},
	}
}

func readPolicy() (map[string]any, error) {
	content, err := os.ReadFile(policyPath)
	if err != nil {
		return nil, fmt.Errorf("read CAO policy: %w", err)
	}
	var document map[string]any
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("%s contains invalid JSON: %w", policyPath, err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s must contain one JSON object", policyPath)
	}
	version, ok := document["version"].(json.Number)
	number, err := version.Float64()
	if !ok || err != nil || number != 1 {
		return nil, fmt.Errorf("%s must declare version 1", policyPath)
	}
	if value, exists := document["control-plane"]; exists {
		control, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s control-plane must be an object", policyPath)
		}
		for _, key := range []string{"campaigns", "workflows", "operations"} {
			if value, exists := control[key]; exists {
				if _, ok := value.(map[string]any); !ok {
					return nil, fmt.Errorf("%s control-plane.%s must be an object", policyPath, key)
				}
			}
		}
	}
	return document, nil
}

func writePolicy(document map[string]any, create bool) (err error) {
	var original []byte
	if !create {
		var err error
		original, err = os.ReadFile(policyPath)
		if err != nil {
			return err
		}
	}
	content, err := orderedPolicyJSON(document, original)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(policyPath), 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(policyPath), ".cao-policy-*.tmp")
	if err != nil {
		return err
	}
	defer func() {
		if removeErr := os.Remove(file.Name()); !errors.Is(removeErr, os.ErrNotExist) {
			err = errors.Join(err, removeErr)
		}
	}()
	if _, err := file.Write(append(content, '\n')); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return err
	}
	if create {
		if err := os.Link(file.Name(), policyPath); err != nil {
			return fmt.Errorf("create CAO policy without overwriting existing files: %w", err)
		}
		return nil
	}
	return os.Rename(file.Name(), policyPath)
}

func campaignNames(names []string) ([]string, error) {
	var result []string
	seen := map[string]bool{}
	for _, name := range names {
		if !slugPattern.MatchString(name) {
			return nil, fmt.Errorf("invalid CAO campaign name: %s", name)
		}
		if !seen[name] {
			seen[name] = true
			result = append(result, name)
		}
	}
	return result, nil
}

func printJSON(cmd *cobra.Command, document any) error {
	encoder := json.NewEncoder(cmd.OutOrStdout())
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(document)
}

func commandError(operation, stderr string, err error) error {
	if message := strings.TrimSpace(stderr); message != "" {
		return fmt.Errorf("%s: %s", operation, message)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
