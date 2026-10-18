package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

type nativeSetupAuthOptions struct {
	repo, policy, readClient, writeClient string
	readName, writeName, expires          string
	write                                 []string
	dryRun, force, noOpen, keep, replace  bool
}

type nativeSetupCredential struct {
	Role        string            `json:"role"`
	Label       string            `json:"-"`
	Variable    string            `json:"variable"`
	Secret      string            `json:"secret"`
	Permissions map[string]string `json:"permissions,omitempty"`
}

func nativeSetupCredentials(pat bool) []nativeSetupCredential {
	read := map[string]string{
		"actions": "read", "contents": "read", "issues": "read", "pull_requests": "read",
		"secret_scanning_alerts": "read", "security_events": "read", "statuses": "read", "vulnerability_alerts": "read",
	}

	if !pat {
		read["checks"], read["packages"] = "read", "read"
	}
	write := map[string]string{"actions": "write", "administration": "read", "contents": "write", "issues": "write", "pull_requests": "write"}
	return []nativeSetupCredential{
		{Role: "read", Label: "read-only", Variable: "GH_AW_GITHUB_READ_APP_ID", Secret: "GH_AW_GITHUB_READ_APP_PRIVATE_KEY", Permissions: read},
		{Role: "write", Label: "write-capable", Variable: "GH_AW_GITHUB_WRITE_APP_ID", Secret: "GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY", Permissions: write},
	}
}

func nativeSetupSortedPermissions(permissions map[string]string) []string {
	keys := make([]string, 0, len(permissions))
	for permission := range permissions {
		keys = append(keys, permission)
	}
	sort.Strings(keys)
	return keys
}

func nativeSetupAuth(cmd *cobra.Command, gh ghExecutor) error {
	for _, name := range []string{"repo", "policy", "read-client-id", "write-client-id", "read-app-name", "write-app-name", "expires-in"} {
		if cmd.Flags().Lookup(name) != nil && cmd.Flags().Changed(name) && strings.TrimSpace(nativeSetupFlag(cmd, name)) == "" {
			return fmt.Errorf("--%s requires a value", name)
		}
	}
	write, _ := cmd.Flags().GetStringArray("write-repository")
	options := nativeSetupAuthOptions{
		repo: nativeSetupFlag(cmd, "repo"), policy: nativeSetupFlag(cmd, "policy"),
		readClient: nativeSetupFlag(cmd, "read-client-id"), writeClient: nativeSetupFlag(cmd, "write-client-id"),
		readName: nativeSetupFlag(cmd, "read-app-name"), writeName: nativeSetupFlag(cmd, "write-app-name"),
		expires: nativeSetupFlag(cmd, "expires-in"), write: write, dryRun: nativeSetupBool(cmd, "dry-run"),
		force: nativeSetupBool(cmd, "force"), noOpen: nativeSetupBool(cmd, "no-open"),
		keep: nativeSetupBool(cmd, "keep-existing"), replace: nativeSetupBool(cmd, "replace-existing"),
	}
	result, err := nativeSetupAuthenticate(cmd, gh, cmd.Name(), options, nil)
	if err != nil {
		return err
	}
	if cmd.Name() == "token" && !options.dryRun {
		repositories := result["repositories"].(map[string]map[string]string)
		owners := []string{}
		for _, secret := range result["secrets"].([]map[string]any) {
			if secret["role"] == "read" {
				owners = append(owners, secret["owner"].(string))
			}
		}
		writeRepositories := make([]string, 0, len(repositories["write"]))
		for repo := range repositories["write"] {
			writeRepositories = append(writeRepositories, repo)
		}
		sort.Strings(writeRepositories)
		noun := "repositories"
		if len(repositories["read"]) == 1 {
			noun = "repository"
		}
		_, err := fmt.Fprintf(cmd.OutOrStdout(), "✓ Fine-grained PAT authentication configured for %s.\n  Read scope: %d %s across %s\n  Write scope: %s\n  Authentication mode: pat\n\nExisting GitHub App credentials, if present, are inactive while PAT mode is selected.\nNext: run gh cao validate, then validate a bounded review workflow before removing App credentials.\n",
			options.repo, len(repositories["read"]), noun, strings.Join(nativeSetupUnique(owners, false), ", "), strings.Join(writeRepositories, ", "))
		return err
	}
	return printJSON(cmd, result)
}

func nativeSetupServerURL() (string, error) {
	server := strings.TrimSpace(os.Getenv("GH_HOST"))
	if server == "" {
		server = strings.TrimSpace(os.Getenv("GITHUB_SERVER_URL"))
	}
	if server == "" {
		server = "github.com"
	}
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}
	parsed, err := url.Parse(server)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
		return "", errors.New("invalid GitHub server URL")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func nativeSetupAuthenticate(cmd *cobra.Command, gh ghExecutor, method string, options nativeSetupAuthOptions, intended map[string]any) (map[string]any, error) {
	if method != "github-app" && method != "enterprise-app" && method != "token" {
		return nil, errors.New("setup auth requires github-app, enterprise-app, or token")
	}
	if method == "github-app" {
		for _, value := range []*string{&options.repo, &options.policy, &options.readClient, &options.writeClient, &options.readName, &options.writeName} {
			*value = strings.TrimSpace(*value)
		}
		options.write = append([]string(nil), options.write...)
		for i := range options.write {
			options.write[i] = strings.TrimSpace(options.write[i])
		}
	}
	if options.repo == "" && method == "github-app" {
		var err error
		options.repo, err = nativeSetupGH(cmd, gh, "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
		if err != nil {
			return nil, err
		}
	}
	if !repositoryPattern.MatchString(options.repo) {
		return nil, errors.New("--repo must be an exact OWNER/REPOSITORY")
	}
	for _, repo := range options.write {
		if !repositoryPattern.MatchString(repo) {
			return nil, errors.New("--write-repository must be an exact OWNER/REPOSITORY")
		}
	}
	if len(options.write) == 0 {
		options.write = []string{options.repo}
	}
	options.write = nativeSetupUnique(options.write, false)
	if options.policy == "" && method != "enterprise-app" {
		options.policy = policyPath
	}
	policy := intended
	if policy == nil && options.policy != "" {
		var err error
		policy, err = nativeSetupReadPolicy(options.policy)
		if err != nil {
			return nil, err
		}
		if method == "github-app" {
			if err := nativeValidatePolicy(policy); err != nil {
				return nil, err
			}
		}
	}
	read := []string{}
	scope := nativeSetupMap(nativeSetupMap(policy["control-plane"])["scope"])
	if value, exists := scope["allowed-repositories"]; exists {
		var ok bool
		read, ok = nativeSetupStrings(value)
		if !ok {
			return nil, errors.New("control-plane.scope.allowed-repositories must contain exact OWNER/REPOSITORY values")
		}
	}
	for _, repo := range read {
		if !repositoryPattern.MatchString(repo) {
			return nil, errors.New("control-plane.scope.allowed-repositories must contain exact OWNER/REPOSITORY values")
		}
	}
	read = nativeSetupUnique(append([]string{options.repo}, read...), false)
	switch method {
	case "github-app":
		return nativeSetupGitHubApps(cmd, gh, options, read)
	case "enterprise-app":
		if options.readClient == "" || options.writeClient == "" {
			return nil, errors.New("enterprise App setup requires --read-client-id and --write-client-id")
		}
		result := map[string]any{
			"command": "setup-auth", "profile": "enterprise-app", "repo": options.repo,
			"repositories": map[string]any{"read": read, "write": options.write},
		}
		if options.dryRun {
			credentials := []map[string]any{}
			for _, profile := range nativeSetupCredentials(false) {
				clientID := options.readClient
				if profile.Role == "write" {
					clientID = options.writeClient
				}
				credentials = append(credentials, map[string]any{"role": profile.Role, "clientId": clientID, "variable": profile.Variable, "secret": profile.Secret})
			}
			result["credentials"] = credentials
			return result, nil
		}
		if _, err := nativeSetupGH(cmd, gh, "auth", "status"); err != nil {
			return nil, err
		}
		for _, profile := range nativeSetupCredentials(false) {
			clientID := options.readClient
			if profile.Role == "write" {
				clientID = options.writeClient
			}
			if _, err := nativeSetupGH(cmd, gh, "variable", "set", profile.Variable, "--repo", options.repo, "--body", clientID); err != nil {
				return nil, err
			}
			if err := nativeSetupNote(cmd, "Enter the %s App private key only at gh's secure secret prompt.\n", profile.Label); err != nil {
				return nil, err
			}
			if _, err := nativeSetupExec(cmd, "gh", nil, "secret", "set", profile.Secret, "--repo", options.repo); err != nil {
				return nil, errors.New("enterprise App private-key setup failed")
			}
		}
		if _, err := nativeSetupGH(cmd, gh, "variable", "set", "GH_AW_GITHUB_AUTH_MODE", "--repo", options.repo, "--body", "app"); err != nil {
			return nil, err
		}
		return result, nil
	default:
		return nativeSetupTokens(cmd, gh, options, read)
	}
}

type nativeSetupOwnerGroup struct {
	Owner        string   `json:"owner"`
	Repositories []string `json:"repositories"`
}

func nativeSetupGroups(repos []string, control string, namesOnly bool) []nativeSetupOwnerGroup {
	groups := []nativeSetupOwnerGroup{}
	index := map[string]int{}
	for _, repo := range repos {
		parts := strings.SplitN(repo, "/", 2)
		key := strings.ToLower(parts[0])
		i, exists := index[key]
		if !exists {
			i = len(groups)
			index[key] = i
			groups = append(groups, nativeSetupOwnerGroup{Owner: parts[0], Repositories: []string{}})
		}
		name := repo
		if namesOnly {
			name = parts[1]
			for j, prior := range groups[i].Repositories {
				if strings.EqualFold(prior, name) {
					groups[i].Repositories[j] = name
					name = ""
					break
				}
			}
		}
		if name != "" {
			groups[i].Repositories = append(groups[i].Repositories, name)
		}
	}
	owner := strings.Split(control, "/")[0]
	for i := range groups {
		sort.Strings(groups[i].Repositories)
	}
	sort.SliceStable(groups, func(i, j int) bool {
		left, right := strings.EqualFold(groups[i].Owner, owner), strings.EqualFold(groups[j].Owner, owner)
		if left != right {
			return left
		}
		return groups[i].Owner < groups[j].Owner
	})
	return groups
}

func nativeSetupOpen(cmd *cobra.Command, gh ghExecutor, address string, noOpen bool) error {
	if !noOpen {
		if _, _, err := gh(cmd.Context(), "browse", address); err == nil {
			return nil
		}
	}
	return nativeSetupNote(cmd, "Open this URL to continue: %s\n", address)
}

func nativeSetupTokens(cmd *cobra.Command, gh ghExecutor, options nativeSetupAuthOptions, read []string) (map[string]any, error) {
	if options.keep && options.replace {
		return nil, errors.New("--keep-existing and --replace-existing cannot be used together")
	}
	if options.expires == "" {
		options.expires = "30"
	}
	days, err := strconv.Atoi(options.expires)
	if err != nil || days < 1 || days > 366 || strconv.Itoa(days) != options.expires {
		return nil, errors.New("--expires-in must be an integer from 1 through 366")
	}
	server, err := nativeSetupServerURL()
	if err != nil {
		return nil, err
	}
	type setup struct {
		nativeSetupCredential
		owner, secret, address string
		repositories           []string
	}
	setups := []setup{}
	secrets := []map[string]any{}
	maps := map[string]map[string]string{"read": {}, "write": {}}
	controlName := strings.Split(options.repo, "/")[1]
	controlName = regexp.MustCompile(`(?i)-token$`).ReplaceAllString(controlName, "")
	for _, profile := range nativeSetupCredentials(true) {
		repos := read
		if profile.Role == "write" {
			repos = options.write
		}
		for _, group := range nativeSetupGroups(repos, options.repo, false) {
			secret := "GH_AW_GITHUB_" + strings.ToUpper(profile.Role) + "_PAT_" + strings.ReplaceAll(strings.ToUpper(group.Owner), "-", "_")
			name := strings.ToUpper("CAO-" + group.Owner + "-" + controlName + "-PAT-" + profile.Role)
			if len(name) > 40 {
				name = name[:40]
			}
			params := url.Values{
				"name": {name}, "description": {"Central Agentic Ops " + profile.Role + " access for " + options.repo},
				"target_name": {group.Owner}, "expires_in": {options.expires},
			}
			for permission, level := range profile.Permissions {
				params.Set(permission, level)
			}
			setups = append(setups, setup{nativeSetupCredential: profile, owner: group.Owner, secret: secret, address: server + "/settings/personal-access-tokens/new?" + params.Encode(), repositories: group.Repositories})
			secrets = append(secrets, map[string]any{"owner": group.Owner, "role": profile.Role, "secret": secret})
			for _, repo := range group.Repositories {
				maps[profile.Role][repo] = secret
			}
		}
	}
	result := map[string]any{"command": "setup-auth", "profile": "fine-grained-token", "secrets": secrets, "repo": options.repo, "repositories": maps}
	if options.dryRun {
		return result, nil
	}
	if _, err := nativeSetupGH(cmd, gh, "auth", "status"); err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	if !options.replace {
		var entries []struct{ Name string }
		if err := nativeSetupJSON(cmd, gh, &entries, "secret", "list", "--repo", options.repo, "--json", "name"); err != nil {
			return nil, err
		}
		if entries == nil {
			return nil, errors.New("existing token lookup returned invalid secret data")
		}
		for _, entry := range entries {
			existing[entry.Name] = true
		}
	}
	for _, setup := range setups {
		keep := options.keep
		if existing[setup.secret] && !keep {
			prompt := nativeSetupGetPrompt(cmd)
			if prompt == nil {
				return nil, fmt.Errorf("%s already exists; rerun with --keep-existing or --replace-existing in a non-interactive environment", setup.secret)
			}
			keep, err = prompt.Confirm("Repository secret "+setup.secret+" already exists. Keep it?", true)
			if err != nil {
				return nil, err
			}
		}
		if existing[setup.secret] && keep {
			if err := nativeSetupNote(cmd, "Skipping existing repository secret %s.\n", setup.secret); err != nil {
				return nil, err
			}
			continue
		}
		if err := nativeSetupNote(cmd, "Create the %s fine-grained PAT for %s:\n- expiration: %d days\n- repository access: Only select repositories\n", setup.Role, setup.owner, days); err != nil {
			return nil, err
		}
		for _, repo := range setup.repositories {
			if err := nativeSetupNote(cmd, "  - %s\n", repo); err != nil {
				return nil, err
			}
		}
		if err := nativeSetupNote(cmd, "- repository permissions:\n"); err != nil {
			return nil, err
		}
		keys := []string{}
		for permission := range setup.Permissions {
			keys = append(keys, permission)
		}
		sort.Strings(keys)
		for _, permission := range keys {
			if err := nativeSetupNote(cmd, "  - %s: %s\n", permission, setup.Permissions[permission]); err != nil {
				return nil, err
			}
		}
		if err := nativeSetupOpen(cmd, gh, setup.address, options.noOpen); err != nil {
			return nil, err
		}
		if err := nativeSetupNote(cmd, "Generate the token, then paste it only into the secure prompt for %s.\n", setup.secret); err != nil {
			return nil, err
		}
		if _, err := nativeSetupExec(cmd, "gh", nil, "secret", "set", setup.secret, "--repo", options.repo); err != nil {
			return nil, fmt.Errorf("%s fine-grained token setup failed", setup.Role)
		}
	}
	for _, role := range []string{"read", "write"} {
		body, _ := json.Marshal(maps[role])
		if _, err := nativeSetupGH(cmd, gh, "variable", "set", "GH_AW_GITHUB_"+strings.ToUpper(role)+"_PAT_REPOSITORIES", "--repo", options.repo, "--body", string(body)); err != nil {
			return nil, err
		}
	}
	if _, err := nativeSetupGH(cmd, gh, "variable", "set", "GH_AW_GITHUB_AUTH_MODE", "--repo", options.repo, "--body", "pat"); err != nil {
		return nil, err
	}
	return result, nil
}
