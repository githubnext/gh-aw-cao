package webhookgateway

import "strings"

func validateCompilerRepos(t CompilerTrigger, l Limits) error {
	if t.Repos == nil {
		return nil
	}
	if t.SchemaVersion != 2 || (t.Event != "dependabot_alert" && t.Event != "code_scanning_alert" && !githubHTMLFamily(t.Event)) ||
		len(t.Repos) == 0 || len(t.Repos) > l.MaxArrayItems {
		return ErrInvalid
	}
	previous := ""
	for _, selector := range t.Repos {
		concrete := selector
		if strings.HasSuffix(selector, "/*") {
			concrete = strings.TrimSuffix(selector, "*") + "repository"
		}
		if !RepositoryNameOK(concrete) || selector != strings.ToLower(selector) || selector <= previous {
			return ErrInvalid
		}
		previous = selector
	}
	return nil
}

// CompilerRepositoryMatches is selection only. Callers must independently bind
// immutable enrollment, private visibility, grants and current installation access.
func CompilerRepositoryMatches(t CompilerTrigger, repository string) bool {
	if !RepositoryNameOK(repository) || validateCompilerRepos(t, DefaultLimits()) != nil {
		return false
	}
	owner, _, _ := strings.Cut(strings.ToLower(repository), "/")
	if !compilerOrgNameMatches(t, owner) {
		return false
	}
	if t.Repos == nil {
		return true
	}
	repository = strings.ToLower(repository)
	for _, selector := range t.Repos {
		if selector == repository || selector == owner+"/*" {
			return true
		}
	}
	return false
}
