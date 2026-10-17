package cli

import (
	"context"
	"fmt"

	"github.com/github/gh-aw/pkg/logger"
	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/internal/ghcli"
	"github.com/githubnext/gh-aw-cao/internal/runtimecli"
)

var log = logger.New("cao:cli")

func NewRootCommand(version string) *cobra.Command {
	return newRootCommand(version, ghcli.Version)
}

func newRootCommand(version string, ghVersion func(context.Context) (string, error)) *cobra.Command {
	return newCommand(version, ghVersion, ghcli.Exec, func(cmd *cobra.Command, args []string) error {
		return runtimecli.Execute(cmd.Context(), args, cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr())
	})
}

type ghExecutor func(context.Context, ...string) (string, string, error)
type runtimeExecutor func(*cobra.Command, []string) error

func newCommand(version string, ghVersion func(context.Context) (string, error), gh ghExecutor, runtime runtimeExecutor) *cobra.Command {
	root := &cobra.Command{
		Use:   "cao",
		Short: "Central Agentic Ops GitHub CLI extension",
		Annotations: map[string]string{
			cobra.CommandDisplayNameAnnotation: "gh cao",
		},
		Long: `Configure and operate Central Agentic Ops from a control repository.

Campaign installation, policy initialization, campaign modes, and workflow enablement run in Go.
Other operator commands use the installed CAO runtime (Node.js 24 or newer).
Activity and Dashboard Actions pipeline commands remain in ./cao.sh.
Help, version, and the read-only doctor diagnostic do not load the CAO runtime.`,
		Version:       version,
		Args:          cobra.NoArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
		PersistentPreRun: func(cmd *cobra.Command, _ []string) {
			log.Printf("Executing command: %s", cmd.Name())
		},
	}
	root.CompletionOptions.DisableDefaultCmd = true
	root.SetVersionTemplate("gh cao version {{.Version}}\n")
	root.AddCommand(
		&cobra.Command{
			Use:   "version",
			Short: "Print the extension version",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				_, err := fmt.Fprintf(cmd.OutOrStdout(), "gh cao version %s\n", version)
				return err
			},
		},
		doctorCommand(ghVersion, gh),
	)
	addPolicyCommands(root, gh)
	root.AddCommand(repositoryCommands(runtime))
	addOperatorCommands(root, runtime)
	return root
}
