package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"

	"github.com/spf13/cobra"
)

var admissionOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)

type admissionTarget struct {
	kind, name string
}

func (t admissionTarget) base() string {
	if t.kind == "organization" {
		return "orgs/" + t.name + "/actions/variables"
	}
	return "repos/" + t.name + "/actions/variables"
}

func configuredAdmissionSettings(execute admissionAPI, repo string) (admissionSettings, error) {
	if repo == "" {
		// gh resolves these placeholders from the current control checkout.
		repo = "{owner}/{repo}"
	} else if !repositoryPattern.MatchString(repo) || len(repo) > 140 {
		return admissionSettings{}, errors.New("--repo must be an exact repository name")
	}
	current, err := readAdmissionVariables(execute, "repos/"+repo+"/actions/variables")
	if err != nil {
		return admissionSettings{}, errors.New("cannot read configured admission server; supply --url explicitly for first-time setup")
	}
	inherited, err := readAdmissionVariables(execute, "repos/"+repo+"/actions/organization-variables")
	if err != nil {
		return admissionSettings{}, errors.New("cannot resolve configured admission server inheritance; supply --url explicitly")
	}
	settings, _ := effectiveAdmissionSettings(current, inherited)
	if settings.URL == "" {
		if repo != "{owner}/{repo}" {
			return configuredAdmissionSettings(execute, "")
		}
		return admissionSettings{}, errors.New("no admission server is configured; supply --url HTTPS_URL once during setup")
	}
	return settings, nil
}

func resolveAdmissionTargets(cmd *cobra.Command, execute admissionAPI, repo string, orgs []string, enterprise string, allRepos bool) ([]admissionTarget, error) {
	selectors := 0
	for _, selected := range []bool{repo != "", len(orgs) != 0, enterprise != "", allRepos} {
		if selected {
			selectors++
		}
	}
	if selectors != 1 {
		return nil, errors.New("select exactly one of --repo OWNER/REPO, --all-repos, --org ORGANIZATION, or --enterprise SLUG")
	}
	targets := []admissionTarget{}
	add := func(kind, name string) error {
		valid := admissionOwnerPattern.MatchString(name)
		if kind == "repository" {
			valid = repositoryPattern.MatchString(name) && len(name) <= 140
		}
		if !valid {
			return fmt.Errorf("invalid admission %s selector", kind)
		}
		for _, existing := range targets {
			if existing.kind == kind && strings.EqualFold(existing.name, name) {
				return nil
			}
		}
		if len(targets) >= 1000 {
			return errors.New("admission rollout exceeds the 1000-target limit; configure smaller explicit scopes")
		}
		targets = append(targets, admissionTarget{kind, name})
		return nil
	}
	switch {
	case repo != "":
		if err := add("repository", repo); err != nil {
			return nil, err
		}
	case len(orgs) != 0:
		for _, org := range orgs {
			if err := add("organization", org); err != nil {
				return nil, err
			}
		}
	case enterprise != "":
		if !admissionOwnerPattern.MatchString(enterprise) {
			return nil, errors.New("--enterprise must be an exact enterprise slug")
		}
		// Enterprise rollout operates on organization variables, never a
		// nonexistent enterprise Actions-variable scope.
		out, err := execute("graphql", "--paginate", "--raw-field",
			`query=query($enterprise: String!, $endCursor: String) { enterprise(slug: $enterprise) { organizations(first: 100, after: $endCursor) { nodes { login } pageInfo { hasNextPage endCursor } } } }`,
			"--raw-field", "enterprise="+enterprise,
			"--jq", ".data.enterprise.organizations.nodes | map(.login)")
		if err != nil {
			return nil, errors.New("cannot enumerate enterprise organizations; verify enterprise read access before configuring organization variables")
		}
		names, err := decodeAdmissionNames(out)
		if err != nil {
			return nil, err
		}
		for _, name := range names {
			if err := add("organization", name); err != nil {
				return nil, err
			}
		}
	case allRepos:
		policy, err := nativeReadValidatedPolicy()
		if err != nil {
			return nil, err
		}
		control, _ := policy["control-plane"].(map[string]any)
		scope, _ := control["scope"].(map[string]any)
		owners, ownersOK := nativeSetupStrings(scope["allowed-owners"])
		repositories, repositoriesOK := nativeSetupStrings(scope["allowed-repositories"])
		if !ownersOK || len(owners) == 0 {
			return nil, errors.New("--all-repos requires explicit CAO scope.allowed-owners")
		}
		if scope["allowed-repositories"] != nil && !repositoriesOK {
			return nil, errors.New("CAO allowed-repositories must be a list of exact repository names")
		}
		if len(repositories) != 0 {
			for _, name := range repositories {
				owner, _, _ := strings.Cut(name, "/")
				if !slices.ContainsFunc(owners, func(allowed string) bool { return strings.EqualFold(allowed, owner) }) {
					return nil, errors.New("CAO repository scope contains an owner outside allowed-owners")
				}
				if err := add("repository", name); err != nil {
					return nil, err
				}
			}
		} else {
			for _, owner := range owners {
				if !admissionOwnerPattern.MatchString(owner) {
					return nil, errors.New("--all-repos requires exact CAO owner names")
				}
				// Only organization inventories are supported for owner-wide scope;
				// failed/partial discovery never widens scope or starts mutations.
				out, err := execute("orgs/"+owner+"/repos?type=all&per_page=100", "--paginate", "--jq", "map(.full_name)")
				if err != nil {
					return nil, errors.New("cannot enumerate CAO owner repositories; personal owners require an explicit allowed-repositories list")
				}
				names, err := decodeAdmissionNames(out)
				if err != nil {
					return nil, err
				}
				for _, name := range names {
					actualOwner, _, _ := strings.Cut(name, "/")
					if !strings.EqualFold(actualOwner, owner) {
						return nil, errors.New("repository discovery returned an owner outside CAO scope")
					}
					if err := add("repository", name); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	if err := cmd.Context().Err(); err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, errors.New("admission scope resolved no targets; no changes applied")
	}
	slices.SortFunc(targets, func(a, b admissionTarget) int {
		return strings.Compare(strings.ToLower(a.name), strings.ToLower(b.name))
	})
	return targets, nil
}

func decodeAdmissionNames(out string) ([]string, error) {
	decoder := json.NewDecoder(strings.NewReader(out))
	var names []string
	pages := 0
	for {
		var page []string
		err := decoder.Decode(&page)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || page == nil {
			return nil, errors.New("GitHub returned incomplete admission scope metadata; no changes applied")
		}
		pages++
		for _, name := range page {
			if name == "" {
				return nil, errors.New("GitHub returned an empty admission scope identity")
			}
		}
		names = append(names, page...)
		if len(names) > 1000 {
			return nil, errors.New("admission scope exceeds 1000 targets; use a smaller explicit scope")
		}
	}
	if pages == 0 {
		return nil, errors.New("GitHub returned no admission scope metadata")
	}
	return names, nil
}

func printAdmissionReports(cmd *cobra.Command, reports []admissionCLIReport, jsonOutput bool) error {
	if len(reports) == 0 {
		return nil
	}
	if len(reports) == 1 {
		return printAdmissionReport(cmd, reports[0], jsonOutput)
	}
	if jsonOutput {
		return printJSON(cmd, map[string]any{"command": reports[0].Command, "results": reports})
	}
	for _, report := range reports {
		if err := printAdmissionReport(cmd, report, false); err != nil {
			return err
		}
	}
	return nil
}
