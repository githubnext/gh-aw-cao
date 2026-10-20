package main

import (
	"encoding/json"
	"errors"
	"os"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

func newAdmissionCommand() *cobra.Command {
	group := &cobra.Command{
		Use: "admission", Short: "Inspect the protected activation-admission configuration",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	var path, audience string
	check := &cobra.Command{
		Use: "validate", Short: "Validate protected admission policy and current accounting without changing state",
		Long: `Validate the authority audience, policy structure, explicit enrollment, and
current accounting freshness/budget for enabled workflow policies. No network
requests, credentials, database writes, or synthetic accounting are introduced.
This local check does not prove issuer reachability, deployment readiness,
workflow compilation, or that a real OIDC invocation will be admitted.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if path == "" {
				path = os.Getenv("CAO_ADMISSION_POLICY_FILE")
			}
			if audience == "" {
				audience = os.Getenv("CAO_ADMISSION_AUDIENCE")
			}
			if path == "" || audience == "" {
				return errors.New("admission validation requires --policy and --audience or CAO_ADMISSION_POLICY_FILE and CAO_ADMISSION_AUDIENCE")
			}
			if _, err := admission.NewVerifier(audience); err != nil {
				return errors.New("admission audience is invalid")
			}
			if err := (admission.FilePolicy{Path: path}).ValidateCurrent(cmd.Context()); err != nil {
				return errors.New("admission snapshot is not ready; verify enrollment, policy structure, fresh complete accounting and available budget")
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{
				"command": "admission validate", "ok": true,
				"scope": "local policy and accounting only",
			})
		},
	}
	check.Flags().StringVar(&path, "policy", "", "Protected snapshot file (default CAO_ADMISSION_POLICY_FILE)")
	check.Flags().StringVar(&audience, "audience", "", "Exact authority audience (default CAO_ADMISSION_AUDIENCE)")
	group.AddCommand(check)
	return group
}
