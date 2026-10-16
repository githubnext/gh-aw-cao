package hostedcli

import (
	"errors"
	"regexp"
	"strings"
	"unicode"
)

// Kind identifies one hosted command family with a fixed permission grant.
type Kind string

const (
	KindGhAwUpgrade Kind = "gh-aw-upgrade"
	KindWorkflowRun Kind = "workflow-run"
	KindCAOUpdate   Kind = "cao-update"
)

// ErrNotHosted reports a declared command that hosted execution refuses.
var ErrNotHosted = errors.New("CLI action is not supported by hosted execution")

var (
	commitRevision   = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
	targetRepository = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`)
	workflowInput    = regexp.MustCompile(`(?s)^[A-Za-z_][A-Za-z0-9_-]*=.*$`)
	campaignSlug     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	workflowName     = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_./-]*$`)
	gitRef           = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_./-]*$`)
)

// Plan is a validated hosted execution: the argv to run, the single
// repository the credential is scoped to, and the least-privilege grant.
type Plan struct {
	Kind Kind
	// Program is "gh" or "cao"; "cao" runs ./cao.sh from a control-repository
	// checkout.
	Program     string
	Args        []string
	Repository  string
	Permissions map[string]string
	// ControlCheckout requests a fresh clone of Repository as the working
	// directory before Program runs.
	ControlCheckout bool
}

// Name returns the repository name without its owner.
func (p Plan) Name() string {
	_, name, _ := strings.Cut(p.Repository, "/")
	return name
}

// Owner returns the repository owner.
func (p Plan) Owner() string {
	owner, _, _ := strings.Cut(p.Repository, "/")
	return owner
}

// Tokenize splits a declared command with the same quoting rules as
// parseDashboardCommand in dashboard/cli-actions.mjs.
func Tokenize(command string) ([]string, error) {
	if command == "" || strings.ContainsAny(command, "\r\n\x00") {
		return nil, errors.New("CLI action command must be a non-empty single line")
	}
	var tokens []string
	var token strings.Builder
	var quote rune
	escaping, started := false, false
	for _, character := range command {
		switch {
		case escaping:
			token.WriteRune(character)
			escaping, started = false, true
		case character == '\\' && quote != '\'':
			escaping, started = true, true
		case quote != 0:
			if character == quote {
				quote = 0
			} else {
				token.WriteRune(character)
			}
			started = true
		case character == '\'' || character == '"':
			quote, started = character, true
		case unicode.IsSpace(character):
			if started {
				tokens = append(tokens, token.String())
				token.Reset()
				started = false
			}
		default:
			token.WriteRune(character)
			started = true
		}
	}
	if escaping || quote != 0 {
		return nil, errors.New("CLI action command contains an incomplete escape or quote")
	}
	if started {
		tokens = append(tokens, token.String())
	}
	return tokens, nil
}

// PlanCommand validates a queued command against the hosted allowlist. It
// fails closed: commands that edit a local checkout without publishing, need
// a user identity, or carry unrecognized options are rejected.
func PlanCommand(command, controlRepository string) (Plan, error) {
	tokens, err := Tokenize(command)
	if err != nil {
		return Plan{}, err
	}
	switch {
	case hasPrefix(tokens, "gh", "aw", "upgrade"):
		return planUpgrade(tokens[3:])
	case hasPrefix(tokens, "gh", "workflow", "run"):
		return planWorkflowRun(tokens[3:], controlRepository)
	case hasPrefix(tokens, "./cao.sh", "update"):
		return planCAOUpdate(tokens[2:], controlRepository)
	case hasPrefix(tokens, "gh", "agent-task"):
		return Plan{}, errors.New("agent tasks require the requesting user's identity and must run locally")
	case hasPrefix(tokens, "./cao.sh"):
		return Plan{}, errors.New("this CAO command edits a local checkout without publishing and must run locally")
	}
	return Plan{}, ErrNotHosted
}

func hasPrefix(tokens []string, prefix ...string) bool {
	if len(tokens) < len(prefix) {
		return false
	}
	for index, value := range prefix {
		if tokens[index] != value {
			return false
		}
	}
	return true
}

// publishingOptions parses the shared --pr-message and boolean publishing
// flags. Mutating hosted commands must publish through a pull request because
// the ephemeral workspace is discarded after the run.
func publishingOptions(args []string, booleans map[string]bool, values map[string]bool) (map[string]string, map[string]bool, error) {
	valueOptions := map[string]string{}
	flags := map[string]bool{}
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case values[argument]:
			if index+1 >= len(args) || strings.HasPrefix(args[index+1], "-") || args[index+1] == "" {
				return nil, nil, errors.New("CLI action option requires a value")
			}
			if _, duplicate := valueOptions[argument]; duplicate {
				return nil, nil, errors.New("CLI action option is repeated")
			}
			valueOptions[argument] = args[index+1]
			index++
		case booleans[argument]:
			flags[argument] = true
		default:
			return nil, nil, ErrNotHosted
		}
	}
	if flags["--auto-merge"] && !flags["--create-pull-request"] {
		return nil, nil, errors.New("--auto-merge requires --create-pull-request")
	}
	if !flags["--create-pull-request"] {
		return nil, nil, errors.New("hosted execution publishes changes only through --create-pull-request")
	}
	return valueOptions, flags, nil
}

var publishingPermissions = map[string]string{
	"contents": "write", "pull_requests": "write", "workflows": "write", "metadata": "read",
}

func planUpgrade(args []string) (Plan, error) {
	values, _, err := publishingOptions(args,
		map[string]bool{"--create-pull-request": true, "--pre-releases": true, "--auto-merge": true},
		map[string]bool{"--repo": true, "--pr-message": true})
	if err != nil {
		return Plan{}, err
	}
	repository := values["--repo"]
	if !targetRepository.MatchString(repository) {
		return Plan{}, errors.New("hosted gh aw upgrade requires --repo OWNER/REPOSITORY")
	}
	return Plan{
		Kind: KindGhAwUpgrade, Program: "gh", Args: append([]string{"aw", "upgrade"}, args...),
		Repository: repository, Permissions: clonePermissions(publishingPermissions),
	}, nil
}

func planWorkflowRun(args []string, controlRepository string) (Plan, error) {
	if len(args) == 0 || !workflowName.MatchString(args[0]) {
		return Plan{}, errors.New("hosted gh workflow run requires a workflow name")
	}
	repository := ""
	normalized := []string{"workflow", "run", args[0]}
	for index := 1; index < len(args); index++ {
		argument, next := args[index], ""
		if index+1 < len(args) {
			next = args[index+1]
		}
		switch {
		case argument == "--repo" || argument == "-R":
			if repository != "" || !targetRepository.MatchString(next) {
				return Plan{}, errors.New("hosted gh workflow run requires one valid --repo")
			}
			repository = next
			index++
		case strings.HasPrefix(argument, "--repo="):
			if repository != "" || !targetRepository.MatchString(strings.TrimPrefix(argument, "--repo=")) {
				return Plan{}, errors.New("hosted gh workflow run requires one valid --repo")
			}
			repository = strings.TrimPrefix(argument, "--repo=")
		case argument == "--ref":
			if !gitRef.MatchString(next) {
				return Plan{}, errors.New("hosted gh workflow run --ref is invalid")
			}
			normalized = append(normalized, "--ref", next)
			index++
		case argument == "-f" || argument == "--raw-field":
			if !workflowInput.MatchString(next) {
				return Plan{}, errors.New("hosted gh workflow run field is invalid")
			}
			normalized = append(normalized, "--raw-field", next)
			index++
		default:
			return Plan{}, ErrNotHosted
		}
	}
	if repository == "" {
		repository = controlRepository
	}
	if !targetRepository.MatchString(repository) {
		return Plan{}, errors.New("hosted gh workflow run requires a target repository")
	}
	normalized = append(normalized, "--repo", repository)
	return Plan{
		Kind: KindWorkflowRun, Program: "gh", Args: normalized, Repository: repository,
		Permissions: map[string]string{"actions": "write", "contents": "read", "metadata": "read"},
	}, nil
}

func planCAOUpdate(args []string, controlRepository string) (Plan, error) {
	if !targetRepository.MatchString(controlRepository) {
		return Plan{}, errors.New("hosted CAO commands require a configured control repository")
	}
	values, _, err := publishingOptions(args,
		map[string]bool{"--create-pull-request": true, "--auto-merge": true, "--pre-releases": true},
		map[string]bool{"--campaign": true, "--pr-message": true})
	if err != nil {
		return Plan{}, err
	}
	if !campaignSlug.MatchString(values["--campaign"]) {
		return Plan{}, errors.New("hosted CAO update requires --campaign with a safe campaign slug")
	}
	return Plan{
		Kind: KindCAOUpdate, Program: "cao", Args: append([]string{"update"}, args...),
		Repository: controlRepository, Permissions: clonePermissions(publishingPermissions), ControlCheckout: true,
	}, nil
}

func clonePermissions(permissions map[string]string) map[string]string {
	clone := make(map[string]string, len(permissions))
	for name, level := range permissions {
		clone[name] = level
	}
	return clone
}

// ValidRepository reports whether value is an OWNER/REPOSITORY name.
func ValidRepository(value string) bool {
	return len(value) <= 256 && targetRepository.MatchString(value)
}
