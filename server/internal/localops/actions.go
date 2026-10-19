package localops

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

var identifier = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
var templateToken = regexp.MustCompile(`\{\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}\}`)
var safeToken = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.:/@-]*$`)
var repositoryToken = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.-]*/[A-Za-z0-9_.][A-Za-z0-9_.-]*$`)
var dispatchRepository = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`)
var workflowInput = regexp.MustCompile(`(?s)^[A-Za-z_][A-Za-z0-9_-]*=.*$`)
var safeURL = regexp.MustCompile(`^https://[A-Za-z0-9._~:/%+-]+$`)

func isContextField(field string) bool {
	return field == "cao-url" || field == "cao-repository" || field == "cao-repository-url"
}

// ParseCommand tokenizes an allowlisted command without shell expansion.
func ParseCommand(command string) ([]string, error) {
	if command == "" || strings.ContainsAny(command, "\r\n\x00") {
		return nil, failure(400, "CLI action command must be a non-empty single line.")
	}
	var tokens []string
	var token strings.Builder
	var quote rune
	escaping, started := false, false
	for _, char := range command {
		switch {
		case escaping:
			token.WriteRune(char)
			escaping, started = false, true
		case char == '\\' && quote != '\'':
			escaping, started = true, true
		case quote != 0:
			if char == quote {
				quote = 0
			} else {
				token.WriteRune(char)
			}
			started = true
		case char == '\'' || char == '"':
			quote, started = char, true
		case unicode.IsSpace(char):
			if started {
				tokens = append(tokens, token.String())
				token.Reset()
				started = false
			}
		default:
			token.WriteRune(char)
			started = true
		}
	}
	if escaping || quote != 0 {
		return nil, failure(400, "CLI action command contains an incomplete escape or quote.")
	}
	if started {
		tokens = append(tokens, token.String())
	}
	allowed := len(tokens) >= 2 && (tokens[0] == "./cao.sh" || tokens[0] == "gh-cao") && !strings.HasPrefix(tokens[1], "-")
	allowed = allowed || len(tokens) >= 3 && tokens[0] == "gh" && tokens[1] == "cao" && tokens[2] != ""
	allowed = allowed || len(tokens) >= 3 && tokens[0] == "gh" && tokens[1] == "aw" && tokens[2] != ""
	allowed = allowed || len(tokens) == 5 && tokens[0] == "gh" && tokens[1] == "agent-task" && tokens[2] == "create" && tokens[3] == "--from-file" && tokens[4] == "-"
	allowed = allowed || len(tokens) >= 4 && tokens[0] == "gh" && tokens[1] == "workflow" && tokens[2] == "run" && validDispatch(tokens[3:])
	if !allowed {
		return nil, failure(400, "CLI action command must be an explicit gh cao, gh-cao, gh aw, gh workflow run, or gh agent-task create invocation.")
	}
	return tokens, nil
}

func nativeOperatorArguments(tokens []string) []string {
	args := tokens[1:]
	if tokens[0] == "gh" {
		args = tokens[2:]
	}
	switch args[0] {
	case "mode", "enable", "disable":
		return append([]string{"campaigns"}, args...)
	case "add":
		if len(args) >= 3 && args[1] == "--repository" {
			return append([]string{"repos", "add"}, args[2:]...)
		}
		if len(args) >= 2 && strings.HasPrefix(args[1], "--repository=") {
			return append([]string{"repos", "add", strings.TrimPrefix(args[1], "--repository=")}, args[2:]...)
		}
		return append([]string{"campaigns"}, args...)
	default:
		return args
	}
}

func validDispatch(args []string) bool {
	if args[0] == "" || strings.HasPrefix(args[0], "-") {
		return false
	}
	for i := 1; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--repo" || arg == "-R":
			i++
			if i >= len(args) || !dispatchRepository.MatchString(args[i]) {
				return false
			}
		case strings.HasPrefix(arg, "--repo="):
			if !dispatchRepository.MatchString(strings.TrimPrefix(arg, "--repo=")) {
				return false
			}
		case arg == "--ref":
			i++
			if i >= len(args) || args[i] == "" || strings.HasPrefix(args[i], "-") {
				return false
			}
		case strings.HasPrefix(arg, "--ref="):
			if arg == "--ref=" {
				return false
			}
		case arg == "--raw-field" || arg == "-f":
			i++
			if i >= len(args) || !workflowInput.MatchString(args[i]) {
				return false
			}
		case strings.HasPrefix(arg, "--raw-field="):
			if !workflowInput.MatchString(strings.TrimPrefix(arg, "--raw-field=")) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func actionByID(document map[string]any, id string) map[string]any {
	for _, candidate := range array(mapping(document["dashboard"])["cli-actions"]) {
		action := mapping(candidate)
		if action["id"] == id {
			return action
		}
	}
	return nil
}

func ResolveAction(document, payload map[string]any, host map[string]string) (Invocation, error) {
	var zero Invocation
	if !onlyKeys(payload, "id", "arguments", "values", "input", "idempotencyKey") || !identifier.MatchString(text(payload["id"])) {
		return zero, failure(400, "Invalid CLI action request.")
	}
	action := actionByID(document, text(payload["id"]))
	if action == nil || text(action["command"]) == "" {
		return zero, failure(404, "CLI action is not declared by this dashboard.")
	}
	if action["copy-only"] == true {
		return zero, failure(403, "CLI action is copy-only.")
	}
	args, values := map[string]bool{}, map[string]string{}
	// JSON decoding also accepts the typed maps returned by queue detail.
	convert := func(value any, target any) error {
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, target)
	}
	if raw, present := payload["arguments"]; present {
		untyped := mapping(raw)
		valid := untyped != nil
		for _, value := range untyped {
			if _, ok := value.(bool); !ok {
				valid = false
			}
		}
		if raw == nil || !valid || convert(raw, &args) != nil || args == nil {
			return zero, failure(400, "Invalid CLI action arguments.")
		}
	}
	if raw, present := payload["values"]; present {
		if raw == nil || convert(raw, &values) != nil || values == nil {
			return zero, failure(400, "Invalid CLI action template values.")
		}
	}
	declared := array(action["arguments"])
	for id := range args {
		found := false
		for _, argument := range declared {
			if mapping(argument)["id"] == id {
				found = true
			}
		}
		if !found {
			return zero, failure(400, "Invalid CLI action arguments.")
		}
	}
	fields := map[string]bool{}
	command := text(action["command"])
	for _, match := range templateToken.FindAllStringSubmatch(command, -1) {
		if !isContextField(match[1]) {
			fields[match[1]] = true
		}
	}
	for field := range values {
		if !fields[field] {
			return zero, failure(400, "Invalid CLI action template values.")
		}
	}
	valid := true
	command = templateToken.ReplaceAllStringFunc(command, func(token string) string {
		field := templateToken.FindStringSubmatch(token)[1]
		value := values[field]
		if isContextField(field) {
			value = host[field]
		}
		limit := 200
		pattern := safeToken
		if field == "repository" || field == "cao-repository" {
			pattern = repositoryToken
		}
		if field == "cao-url" || field == "cao-repository-url" {
			limit, pattern = 2048, safeURL
		}
		if value == "" || len(value) > limit || !pattern.MatchString(value) {
			valid = false
		}
		if pattern == safeURL {
			u, err := url.Parse(value)
			if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" || u.Scheme != "https" {
				valid = false
			}
		}
		return value
	})
	if !valid || strings.Contains(command, "{{") || strings.Contains(command, "}}") {
		return zero, failure(400, "Invalid CLI action template values.")
	}
	for _, candidate := range declared {
		argument := mapping(candidate)
		enabled, exists := args[text(argument["id"])]
		if !exists {
			enabled = argument["default"] == true
		}
		if enabled {
			flag := text(argument["flag"])
			if flag == "" {
				return zero, failure(400, "Invalid CLI action declaration.")
			}
			command += " " + flag
		}
	}
	var input *string
	if raw := payload["input"]; raw != nil {
		value, ok := raw.(string)
		if !ok || value == "" || len([]rune(value)) > 100000 {
			return zero, failure(400, "Invalid CLI action input.")
		}
		input = &value
	}
	if (input != nil) != (command == "gh agent-task create --from-file -") {
		return zero, failure(400, "CLI action input is not valid for this command.")
	}
	if _, err := ParseCommand(command); err != nil {
		return zero, err
	}
	return Invocation{ActionID: text(action["id"]), Command: command, Arguments: args, Values: values, Input: input}, nil
}
