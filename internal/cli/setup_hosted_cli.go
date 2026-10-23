package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
)

func nativeSetupHostedProfile() nativeSetupCredential {
	return nativeSetupCredential{
		Role: "hosted-cli", Label: "hosted CLI executor",
		Permissions: map[string]string{
			"actions": "write", "contents": "write", "metadata": "read",
			"pull_requests": "write", "workflows": "write",
		},
	}
}

func nativeSetupHostedCLI(cmd *cobra.Command, gh ghExecutor) (err error) {
	for _, name := range []string{"repo", "app-name", "private-key-out"} {
		if cmd.Flags().Changed(name) && strings.TrimSpace(nativeSetupFlag(cmd, name)) == "" {
			return fmt.Errorf("--%s requires a value", name)
		}
	}
	repo := strings.TrimSpace(nativeSetupFlag(cmd, "repo"))
	coordinate := regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9_.-]+$`)
	if !coordinate.MatchString(repo) {
		return errors.New("--repo must be an exact OWNER/REPOSITORY")
	}
	repositories := []string{repo}
	additional, _ := cmd.Flags().GetStringArray("target-repository")
	owner, control, _ := strings.Cut(repo, "/")
	for _, target := range additional {
		target = strings.TrimSpace(target)
		if !coordinate.MatchString(target) {
			return errors.New("--target-repository must be an exact OWNER/REPOSITORY")
		}
		targetOwner, _, _ := strings.Cut(target, "/")
		if !strings.EqualFold(owner, targetOwner) {
			return fmt.Errorf("private organization-owned Apps cannot be installed on %s; use a hosted CLI App owned by that organization", targetOwner)
		}
		repositories = append(repositories, target)
	}
	targets := nativeSetupGroups(repositories, repo, true)
	name := strings.TrimSpace(nativeSetupFlag(cmd, "app-name"))
	if name == "" {
		name = nativeSetupAppName(repo, "cli")
	}
	if err := nativeSetupValidateAppName(name); err != nil {
		return err
	}
	dryRun := nativeSetupBool(cmd, "dry-run")
	keyPath := strings.TrimSpace(nativeSetupFlag(cmd, "private-key-out"))
	if !dryRun && keyPath == "" {
		return errors.New("--private-key-out PATH is required; the private key is never printed")
	}
	server, err := nativeSetupServerURL()
	if err != nil {
		return err
	}
	api, err := nativeSetupNewAppAPI()
	if err != nil {
		return err
	}
	profile := nativeSetupHostedProfile()
	if dryRun {
		return printJSON(cmd, map[string]any{
			"repo": repo, "installationTargets": targets,
			"manifest": nativeSetupAppManifest(name, server+"/"+repo, "http://127.0.0.1:0/callback", nativeSetupAppDescription(repo, profile), profile.Permissions),
			"environment": map[string]string{
				"appId": "CAO_HOSTED_CLI_APP_ID", "privateKeyFile": "CAO_HOSTED_CLI_PRIVATE_KEY_FILE",
				"controlRepository": "CAO_HOSTED_CLI_CONTROL_REPOSITORY", "apiUrl": "CAO_HOSTED_CLI_GITHUB_API_URL",
			},
		})
	}
	keyPath, err = filepath.Abs(keyPath)
	if err != nil {
		return err
	}
	// Reserve the destination before creating an App. O_EXCL also rejects symlinks.
	key, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("reserve private-key bootstrap file: %w", err)
	}
	saved := false
	defer func() {
		if key != nil {
			err = errors.Join(err, key.Close())
		}
		if !saved {
			err = errors.Join(err, os.Remove(keyPath))
		}
	}()
	if _, err := nativeSetupGH(cmd, gh, "auth", "status"); err != nil {
		return err
	}
	canonical, err := nativeSetupGH(cmd, gh, "repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner")
	if err != nil {
		return err
	}
	if !strings.EqualFold(canonical, repo) {
		return errors.New("repository resolved to unexpected slug")
	}
	if _, err := nativeSetupGH(cmd, gh, "api", "/users/"+owner, "--jq", ".login"); err != nil {
		return err
	}
	noOpen := nativeSetupBool(cmd, "no-open")
	controlTarget := nativeSetupOwnerGroup{Owner: owner, Repositories: []string{control}}
	app, err := nativeSetupCreateApp(cmd, gh, controlTarget, name, server+"/"+canonical, profile, noOpen)
	if err != nil {
		return err
	}
	// Preserve the only downloaded key even if subsequent installation checks fail.
	saved = true
	if _, err := io.WriteString(key, strings.TrimSuffix(app.PEM, "\n")+"\n"); err != nil {
		return errors.New("unable to write App private key to bootstrap file; recover or rotate the key in GitHub App settings")
	}
	if err := key.Sync(); err != nil {
		return errors.New("unable to sync App private-key bootstrap file; recover or rotate the key in GitHub App settings")
	}
	closeErr := key.Close()
	key = nil
	if closeErr != nil {
		return errors.New("unable to close App private-key bootstrap file; recover or rotate the key in GitHub App settings")
	}
	if err := nativeSetupNote(cmd, "Wrote the private key to %s with mode 0600.\nImport it into the execute-cli deployment's secret manager, then securely remove this bootstrap file.\n", keyPath); err != nil {
		return err
	}
	app, err = nativeSetupAuthenticateApp(cmd.Context(), api, app, profile)
	if err != nil {
		return err
	}
	if err := nativeSetupEnsureInstallations(cmd, gh, api, app, []nativeSetupOwnerGroup{controlTarget}, noOpen, true); err != nil {
		return err
	}
	installation, err := api.installation(cmd.Context(), app, owner)
	if err != nil {
		return err
	}
	if installation == nil {
		return errors.New("hosted CLI App installation could not be verified")
	}
	if installation.Selection != "selected" {
		return errNativeSetupInstallationScope
	}
	selected, err := api.installationRepositories(cmd.Context(), app, installation.ID.String())
	if err != nil {
		return err
	}
	missing := []string{}
	for _, name := range targets[0].Repositories {
		if !selected[strings.ToLower(owner+"/"+name)] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		if err := nativeSetupHostedAddRepositories(cmd, gh, installation.ID.String(), owner, missing); err != nil {
			if cmd.Context().Err() != nil {
				return cmd.Context().Err()
			}
			if err := nativeSetupNote(cmd, "Repository addition requires administrator access on each repository; continuing in the browser. New installations and organization-restricted additions still require the appropriate approval.\n"); err != nil {
				return err
			}
			if err := nativeSetupEnsureInstallations(cmd, gh, api, app, targets, noOpen, false); err != nil {
				return err
			}
		}
	}
	verified, err := api.covers(cmd.Context(), app, targets[0])
	if err != nil {
		return err
	}
	if verified == nil {
		return errors.New("hosted CLI App installation does not cover every requested repository")
	}
	if err := nativeSetupNote(cmd, "\nConfigure the execute-cli worker (not serve-hosted) with:\n  CAO_HOSTED_CLI_APP_ID=%s\n  CAO_HOSTED_CLI_PRIVATE_KEY_FILE=%s\n  CAO_HOSTED_CLI_CONTROL_REPOSITORY=%s\n  CAO_HOSTED_CLI_GITHUB_API_URL=%s\nKeep this App separate from the dashboard login App and Actions read/write Apps. Rotate keys from the App's Credentials tab. CAO policy and hosted-feature gates are unchanged.\n", app.ID, keyPath, repo, api.base); err != nil {
		return err
	}
	return printJSON(cmd, map[string]string{"command": "setup-auth", "profile": "hosted-cli"})
}

func nativeSetupHostedAddRepositories(cmd *cobra.Command, gh ghExecutor, installationID, owner string, repositories []string) error {
	for _, repository := range repositories {
		id, _, err := gh(cmd.Context(), "api", "/repos/"+owner+"/"+repository, "--jq", ".id")
		if err != nil || !regexp.MustCompile(`^[1-9][0-9]*$`).MatchString(strings.TrimSpace(id)) {
			return errors.New("unable to resolve repository ID for hosted CLI App installation")
		}
		if _, _, err := gh(cmd.Context(), "api", "-X", "PUT", "/user/installations/"+installationID+"/repositories/"+strings.TrimSpace(id), "--silent"); err != nil {
			return errors.New("unable to add repository to hosted CLI App installation")
		}
	}
	return nativeSetupNote(cmd, "Added %s to installation %s.\n", strings.Join(repositories, ", "), installationID)
}
