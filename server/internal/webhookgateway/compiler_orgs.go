package webhookgateway

import (
	"path"
	"regexp"
	"strings"
)

var compilerOrgPattern = regexp.MustCompile(`^[a-z0-9*]([a-z0-9*-]{0,37}[a-z0-9*])?$`)

func validateCompilerOrgs(t CompilerTrigger, l Limits) error {
	if t.Orgs == nil {
		return nil
	}
	if t.SchemaVersion != 2 || len(t.Orgs) == 0 || len(t.Orgs) > l.MaxArrayItems ||
		t.Event != "projects_v2_item" && SecurityEventPermission(t.Event) == "" && !githubHTMLFamily(t.Event) {
		return ErrInvalid
	}
	previous := ""
	for _, selector := range t.Orgs {
		if !compilerOrgPattern.MatchString(selector) || selector <= previous {
			return ErrInvalid
		}
		previous = selector
	}
	return nil
}

func compilerOrgNameMatches(t CompilerTrigger, organization string) bool {
	if t.Orgs == nil {
		return true
	}
	organization = strings.ToLower(organization)
	if !compilerOrgPattern.MatchString(organization) || strings.Contains(organization, "*") {
		return false
	}
	for _, selector := range t.Orgs {
		if matches, _ := path.Match(selector, organization); matches {
			return true
		}
	}
	return false
}

// CompilerOrganizationMatches intersects selectors with authenticated organization
// identity; a URL owner or wildcard alone never establishes organization authority.
func CompilerOrganizationMatches(t CompilerTrigger, organization string, ownerID int64, ownerType string) bool {
	return t.Orgs == nil || ownerID > 0 && ownerType == "Organization" && compilerOrgNameMatches(t, organization)
}
