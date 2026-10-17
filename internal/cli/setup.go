package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

func setupCommand(execute runtimeExecutor) *cobra.Command {
	setup := operatorCommand("setup", "Configure repository scope and authentication", cobra.NoArgs, []operatorFlag{jsonFlag}, execute)
	setup.Long = `Configure the control plane's repository scope, dashboard Pages, and authentication.

Run without a subcommand for guided setup, or use auth to configure credentials
independently. Non-interactive setup applies only the bounded public profile.
Setup uses the installed CAO runtime (Node.js 24 or newer); help works offline.`
	auth := &cobra.Command{
		Use: "auth", Short: "Configure read and write authentication", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf("setup auth requires github-app, enterprise-app, or token")
		},
	}
	authenticate := func(cmd *cobra.Command, args []string) error {
		// Keep the production runtime's setup-auth contract behind the Go hierarchy.
		return execute(cmd, append([]string{"setup-auth"}, args[2:]...))
	}
	common := []operatorFlag{
		textFlag("repo", "Control repository OWNER/REPO"), textFlag("policy", "CAO policy path"),
		{name: "write-repository", description: "Explicit safe-output repository OWNER/REPO (repeatable)", repeat: true},
		boolFlag("dry-run", "Describe configuration without applying it"),
	}
	app := operatorCommand("github-app", "Configure organization-owned read and write GitHub Apps", cobra.NoArgs, appendFlags(common,
		textFlag("read-client-id", "Existing read App client ID"), textFlag("write-client-id", "Existing write App client ID"),
		textFlag("read-app-name", "Name for a new read App"), textFlag("write-app-name", "Name for a new write App"),
		boolFlag("force", "Replace the selected App configuration"), boolFlag("no-open", "Print browser URLs instead of opening them"),
	), authenticate)
	enterprise := operatorCommand("enterprise-app", "Configure existing enterprise-owned GitHub Apps", cobra.NoArgs, appendFlags(common,
		textFlag("read-client-id", "Read App client ID"), textFlag("write-client-id", "Write App client ID"),
	), authenticate)
	token := operatorCommand("token", "Configure explicitly scoped fine-grained PAT pairs", cobra.NoArgs, appendFlags(common,
		textFlag("expires-in", "Token expiration in days, 1 through 366 (default 30)"),
		boolFlag("no-open", "Print token-creation URLs instead of opening them"),
		boolFlag("keep-existing", "Preserve existing token secrets"),
		boolFlag("replace-existing", "Replace existing token secrets"),
	), authenticate)
	token.MarkFlagsMutuallyExclusive("keep-existing", "replace-existing")
	auth.AddCommand(app, enterprise, token)
	setup.AddCommand(auth)
	return setup
}
