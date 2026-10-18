package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

type operatorFlag struct {
	name, short, description string
	repeat, boolean          bool
}

func textFlag(name, description string) operatorFlag {
	return operatorFlag{name: name, description: description}
}

func boolFlag(name, description string) operatorFlag {
	return operatorFlag{name: name, description: description, boolean: true}
}

var (
	databaseFlag  = textFlag("database", "Existing SQLite snapshot (default .cao/gh-aw-logs.sqlite)")
	dashboardFlag = textFlag("dashboard", "Dashboard Language document")
	jsonFlag      = boolFlag("json", "Write machine-readable JSON")
	paramFlag     = operatorFlag{name: "param", description: "Query parameter NAME=VALUE (repeatable)", repeat: true}
)

func addOperatorCommands(root *cobra.Command, execute runtimeExecutor) {
	quickstart := operatorCommand("quickstart", "Install, run, collect, or inspect a bounded first review", cobra.NoArgs, []operatorFlag{
		textFlag("step", "install (default), run, collect, or dashboard"),
		textFlag("target", "Explicit public target OWNER/REPO for installation"),
		textFlag("campaign", "CAO campaign package for installation"),
		boolFlag("wait", "Install and wait for the complete end-to-end journey"),
		jsonFlag,
	}, execute)
	quickstart.PreRunE = validateQuickstart
	validate := operatorCommand("validate", "Validate control-plane policy and workflow installation", cobra.NoArgs, []operatorFlag{
		jsonFlag, boolFlag("strict-warnings", "Fail on validation warnings"),
	}, execute)
	download := operatorCommand("download", "Download the deployed CAO evidence snapshot", cobra.NoArgs, []operatorFlag{
		textFlag("url", "Dashboard payload-hashes.json URL"),
		textFlag("output", "Local output directory (default .cao)"),
		textFlag("manifest-sha256", "Trusted SHA-256 digest of the manifest"),
	}, execute)
	pages := operatorCommand("pages [PAGE_ID]", "List or describe agent-facing dashboard pages", cobra.MaximumNArgs(1), []operatorFlag{dashboardFlag, jsonFlag}, execute)
	queries := operatorCommand("queries", "List reviewed dashboard queries", cobra.NoArgs, []operatorFlag{dashboardFlag, jsonFlag}, execute)
	info := operatorCommand("query-info QUERY_ID", "Describe one reviewed dashboard query", cobra.ExactArgs(1), []operatorFlag{dashboardFlag, jsonFlag}, execute)
	prompt := operatorCommand("prompt QUERY_ID", "Render a reviewed query as an agent prompt", cobra.ExactArgs(1), []operatorFlag{dashboardFlag, databaseFlag, paramFlag}, execute)
	query := operatorCommand("query [QUERY_ID]", "Query the local canonical snapshot", cobra.MaximumNArgs(1), []operatorFlag{
		databaseFlag, dashboardFlag, paramFlag,
		textFlag("collection", "Canonical collection name"), textFlag("id", "Record or named query identifier"),
		{name: "where", description: "Canonical FIELD=VALUE predicate (repeatable)", repeat: true},
		textFlag("limit", "Maximum result count"), boolFlag("stdin", "Read a Dashboard Language query from stdin"),
	}, execute)
	query.MarkFlagsMutuallyExclusive("stdin", "collection")
	query.MarkFlagsMutuallyExclusive("stdin", "id")
	query.MarkFlagsMutuallyExclusive("stdin", "where")
	query.MarkFlagsMutuallyExclusive("stdin", "limit")
	mcp := operatorCommand("mcp", "Serve read-only local CAO queries over MCP", cobra.NoArgs, []operatorFlag{
		databaseFlag, dashboardFlag, textFlag("host", "Bind host (default 127.0.0.1)"), textFlag("port", "Bind port (default 8765)"),
	}, execute)
	upgrade := operatorCommand("upgrade-gh-aw VERSION", "Upgrade gh-aw and its policy pin to an exact release", cobra.ExactArgs(1), nil, execute)
	gh := &cobra.Command{
		Use: "gh", Short: "Inspect workflow runs and safe-output issues or pull requests", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf("gh requires runs, issues, or prs")
		},
	}
	ghFlags := []operatorFlag{
		databaseFlag,
		{name: "repo", short: "R", description: "Exact execution or target repository OWNER/REPO"},
		{name: "workflow", short: "w", description: "Producing workflow name, path, file, or ID"},
		{name: "limit", short: "L", description: "Maximum results, newest first (default 30)"},
		textFlag("since", "Include results at or after ISO 8601 time"), textFlag("until", "Include results at or before ISO 8601 time"),
	}
	gh.AddCommand(
		operatorCommand("runs", "List workflow runs", cobra.NoArgs, appendFlags(ghFlags, operatorFlag{name: "status", short: "s", description: "Run status or conclusion"}), execute),
		operatorCommand("issues", "List safe-output issues", cobra.NoArgs, ghFlags, execute),
		operatorCommand("prs", "List safe-output pull requests", cobra.NoArgs, ghFlags, execute),
	)
	computation := &cobra.Command{
		Use: "computation", Short: "Compute advisory intelligence from local evidence", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf("computation requires intelligence or runtime-health")
		},
	}
	computationFlags := []operatorFlag{databaseFlag, textFlag("inventory", "Campaign inventory JSON"), textFlag("campaign", "Limit evidence to a campaign slug")}
	intelligence := operatorCommand("intelligence", "Compute portfolio intelligence and advisory decisions", cobra.NoArgs, appendFlags(computationFlags,
		textFlag("previous", "Previous intelligence result"), textFlag("feedback", "Versioned decision feedback"),
	), execute)
	health := operatorCommand("runtime-health", "Compute runtime health from canonical evidence", cobra.NoArgs, appendFlags(computationFlags,
		boolFlag("diagnose", "Diagnose the selected campaign"),
	), execute)
	health.PreRunE = func(cmd *cobra.Command, _ []string) error {
		diagnose, _ := cmd.Flags().GetBool("diagnose")
		campaign, _ := cmd.Flags().GetString("campaign")
		if diagnose && campaign == "" {
			return fmt.Errorf("--diagnose requires --campaign SLUG")
		}
		return nil
	}
	computation.AddCommand(intelligence, health)
	root.AddCommand(setupCommand(execute), quickstart, validate, download, pages, queries, info, prompt, query, mcp, upgrade, gh, computation,
		passthroughCommand("update [REF] [GH_AW_OPTIONS...]", "Update installed CAO packages without widening rollout", execute),
	)
}

func appendFlags(base []operatorFlag, extra ...operatorFlag) []operatorFlag {
	return append(append([]operatorFlag(nil), base...), extra...)
}

func operatorCommand(use, short string, args cobra.PositionalArgs, flags []operatorFlag, execute runtimeExecutor) *cobra.Command {
	cmd := &cobra.Command{Use: use, Short: short, Args: args}
	for _, flag := range flags {
		if flag.boolean {
			cmd.Flags().BoolP(flag.name, flag.short, false, flag.description)
			if flag.name == "wait" {
				value := cmd.Flags().Lookup(flag.name)
				value.Value = &singleValue{Value: value.Value, name: flag.name}
			}
		} else if flag.repeat {
			cmd.Flags().StringArrayP(flag.name, flag.short, nil, flag.description)
		} else {
			cmd.Flags().StringP(flag.name, flag.short, "", flag.description)
			value := cmd.Flags().Lookup(flag.name)
			value.Value = &singleValue{Value: value.Value, name: flag.name}
		}
	}
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		arguments := commandWords(cmd)
		arguments = append(arguments, args...)
		// Send explicit values only; each native handler owns its defaults.
		cmd.Flags().Visit(func(flag *pflag.Flag) {
			if flag.Name == "help" {
				return
			}
			if flag.Value.Type() == "bool" {
				if flag.Value.String() == "true" {
					arguments = append(arguments, "--"+flag.Name)
				}
			} else if flag.Value.Type() == "stringArray" {
				values, _ := cmd.Flags().GetStringArray(flag.Name)
				for _, value := range values {
					arguments = append(arguments, "--"+flag.Name, value)
				}
			} else {
				arguments = append(arguments, "--"+flag.Name, flag.Value.String())
			}
		})
		return execute(cmd, arguments)
	}
	return cmd
}

// gh-aw update options evolve independently; retain their exact order and values.
func passthroughCommand(use, short string, execute runtimeExecutor) *cobra.Command {
	cmd := &cobra.Command{Use: use, Short: short, DisableFlagParsing: true}
	cmd.Long = short + ".\n\nOptions are passed unchanged to gh-aw after native CAO validation.\nUse --campaign SLUG with update."
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		for _, arg := range args {
			if arg == "--" {
				break
			}
			if arg == "--help" || arg == "-h" {
				return cmd.Help()
			}
		}
		return execute(cmd, append(commandWords(cmd), args...))
	}
	return cmd
}

func commandWords(cmd *cobra.Command) []string {
	var words []string
	for current := cmd; current.Parent() != nil; current = current.Parent() {
		words = append([]string{current.Name()}, words...)
	}
	return words
}

type singleValue struct {
	pflag.Value
	name string
	set  bool
}

func (v *singleValue) Set(value string) error {
	if v.set {
		return fmt.Errorf("option --%s may only be specified once", v.name)
	}
	v.set = true
	return v.Value.Set(value)
}

func validateQuickstart(cmd *cobra.Command, _ []string) error {
	step, _ := cmd.Flags().GetString("step")
	wait, _ := cmd.Flags().GetBool("wait")
	target, _ := cmd.Flags().GetString("target")
	campaign, _ := cmd.Flags().GetString("campaign")
	if cmd.Flags().Changed("step") && step != "install" && step != "run" && step != "collect" && step != "dashboard" {
		return fmt.Errorf("--step requires install, run, collect, or dashboard")
	}
	if wait && cmd.Flags().Changed("step") {
		return fmt.Errorf("--wait cannot be combined with --step")
	}
	if step != "" && step != "install" && (cmd.Flags().Changed("target") || cmd.Flags().Changed("campaign")) {
		return fmt.Errorf("--target and --campaign are only valid for install or --wait")
	}
	if (step == "" || step == "install") && !repositoryPattern.MatchString(target) {
		return fmt.Errorf("quickstart install and --wait require explicit --target OWNER/REPO")
	}
	if cmd.Flags().Changed("campaign") && (campaign == "" || strings.HasPrefix(campaign, "-")) {
		return fmt.Errorf("--campaign requires a CAO campaign package")
	}
	return nil
}
