package cli

import (
	"context"
	"fmt"

	"github.com/github/gh-aw/pkg/logger"
	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/internal/ghcli"
)

var log = logger.New("cao:cli")

func NewRootCommand(version string) *cobra.Command {
	return newRootCommand(version, ghcli.Version)
}

func newRootCommand(version string, ghVersion func(context.Context) (string, error)) *cobra.Command {
	root := &cobra.Command{
		Use:   "cao",
		Short: "Central Agentic Ops GitHub CLI extension",
		Annotations: map[string]string{
			cobra.CommandDisplayNameAnnotation: "gh cao",
		},
		Long: `Central Agentic Ops GitHub CLI extension scaffold.

Only help, version, and a local GitHub CLI diagnostic are implemented.
Continue using ./cao.sh for existing CAO operations; command parity is future work.`,
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
		&cobra.Command{
			Use:   "doctor",
			Short: "Check the local GitHub CLI executable without accessing GitHub",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				installedVersion, err := ghVersion(cmd.Context())
				if err != nil {
					return err
				}
				_, err = fmt.Fprintf(cmd.OutOrStdout(), "%s\n\nLocal executable check only; authentication, gh-aw, and CAO policy were not checked.\n", installedVersion)
				return err
			},
		},
	)
	return root
}
