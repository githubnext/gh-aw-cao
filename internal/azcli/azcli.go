// Package azcli runs the Azure CLI as a cancellable child process.
//
// Callers must never place secret values in argv. Secure deployment values
// belong in owner-only parameter files or Key Vault references.
package azcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Result is the captured output of one Azure CLI invocation.
type Result struct {
	Stdout string
	Stderr string
}

// Executor runs one Azure CLI invocation. Implementations must honor ctx.
type Executor interface {
	Run(ctx context.Context, args ...string) (Result, error)
}

// ExecutorFunc adapts a function to Executor.
type ExecutorFunc func(context.Context, ...string) (Result, error)

func (f ExecutorFunc) Run(ctx context.Context, args ...string) (Result, error) {
	return f(ctx, args...)
}

// Process runs the az binary found on PATH when the first command executes.
type Process struct {
	// Path overrides PATH lookup; empty means "az".
	Path string
	// WaitDelay bounds how long output pipes may outlive a cancelled process.
	WaitDelay time.Duration
}

// ExitError reports a non-zero Azure CLI exit. Stderr is retained for callers
// that redact it before display.
type ExitError struct {
	Code   int
	Stderr string
}

func (e *ExitError) Error() string {
	message := strings.TrimSpace(e.Stderr)
	if message == "" {
		return fmt.Sprintf("az exited with status %d", e.Code)
	}
	return fmt.Sprintf("az exited with status %d: %s", e.Code, message)
}

func (p Process) Run(ctx context.Context, args ...string) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	path := p.Path
	if path == "" {
		found, err := exec.LookPath("az")
		if err != nil {
			return Result{}, fmt.Errorf("find Azure CLI (install az and ensure it is on PATH): %w", err)
		}
		path = found
	}
	command := exec.CommandContext(ctx, path, args...)
	command.Env = append(os.Environ(),
		"AZURE_CORE_ONLY_SHOW_ERRORS=true",
		"AZURE_CORE_NO_COLOR=true",
		"AZURE_CORE_SURVEY_MESSAGE=false",
	)
	command.WaitDelay = p.WaitDelay
	if command.WaitDelay == 0 {
		command.WaitDelay = 5 * time.Second
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	result := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return result, fmt.Errorf("az %s: %w", CommandName(args), ctxErr)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return result, &ExitError{Code: exit.ExitCode(), Stderr: result.Stderr}
	}
	if err != nil {
		return result, fmt.Errorf("run az %s: %w", CommandName(args), err)
	}
	return result, nil
}

// readOnlyCommands lists the only Azure CLI command paths that plan and
// preflight modes may run. `az rest` is handled separately by isReadOnlyRest.
var readOnlyCommands = [][]string{
	{"version"},
	{"account", "show"},
	{"group", "exists"},
	{"resource", "list"},
	{"resource", "show"},
	{"provider", "list"},
	{"role", "assignment", "list"},
	{"ad", "signed-in-user", "show"},
	{"ad", "sp", "show"},
	{"storage", "account", "check-name"},
	{"acr", "check-name"},
	{"keyvault", "list-deleted"},
	{"appservice", "list-locations"},
	{"postgres", "flexible-server", "list-skus"},
	{"functionapp", "config", "appsettings", "list"},
	{"deployment", "group", "what-if"},
	{"deployment", "sub", "what-if"},
}

// readOnlyRestPaths are the only ARM paths `az rest` may call. Each is a
// checkNameAvailability action: a POST that reads global name state and
// changes nothing. Effective-permissions GETs are separately allowlisted.
var readOnlyRestPaths = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.KeyVault/checkNameAvailability$`),
	regexp.MustCompile(`(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.Web/checkNameAvailability$`),
	regexp.MustCompile(`(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.DBforPostgreSQL/checkNameAvailability$`),
	regexp.MustCompile(`(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.DBforPostgreSQL/locations/[a-z0-9]{2,40}/checkNameAvailability$`),
}

var readOnlyPermissionsPath = regexp.MustCompile(`(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/resourceGroups/[-a-z0-9_.()]+)?/providers/Microsoft\.Authorization/permissions$`)
var readOnlyGeoRegionsPath = regexp.MustCompile(`(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/providers/Microsoft\.Web/geoRegions$`)

// IsReadOnly reports whether args name an allowlisted read-only or what-if command.
func IsReadOnly(args []string) bool {
	path := CommandPath(args)
	if slices.Equal(path, []string{"rest"}) {
		return isReadOnlyRest(args[1:])
	}
	for _, allowed := range readOnlyCommands {
		if slices.Equal(path, allowed) {
			return true
		}
	}
	return false
}

// isReadOnlyRest accepts only `az rest --method post --url <checkNameAvailability>`
// against the ARM endpoint with an api-version query and no other options that
// could change the target or method.
func isReadOnlyRest(options []string) bool {
	valued := map[string]string{
		"--method": "method", "-m": "method",
		"--url": "url", "--uri": "url", "-u": "url",
		"--body": "body", "-b": "body",
		"--output": "", "-o": "", "--query": "",
	}
	seen := map[string]bool{}
	var method, target string
	for index := 0; index < len(options); index++ {
		name, value, inline := strings.Cut(options[index], "=")
		role, ok := valued[name]
		if !ok {
			return false
		}
		if !inline {
			index++
			if index >= len(options) {
				return false
			}
			value = options[index]
		}
		if role == "" {
			continue
		}
		if seen[role] {
			return false
		}
		seen[role] = true
		switch role {
		case "method":
			method = value
		case "url":
			target = value
		}
	}
	if target == "" {
		return false
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.RawPath != "" || parsed.Fragment != "" || parsed.User != nil || path.Clean(parsed.Path) != parsed.Path {
		return false
	}
	switch {
	case parsed.Scheme == "" && parsed.Host == "":
	case parsed.Scheme == "https" && strings.EqualFold(parsed.Host, "management.azure.com"):
	default:
		return false
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return false
	}
	if len(query["api-version"]) != 1 {
		return false
	}
	if strings.EqualFold(method, "get") {
		if seen["body"] {
			return false
		}
		if readOnlyPermissionsPath.MatchString(parsed.Path) {
			return len(query) == 1 && query.Get("api-version") == "2022-04-01"
		}
		return readOnlyGeoRegionsPath.MatchString(parsed.Path) && len(query) == 3 &&
			query.Get("api-version") == "2024-11-01" && len(query["sku"]) == 1 &&
			(query.Get("sku") == "EP1" || query.Get("sku") == "EP2" || query.Get("sku") == "EP3") &&
			len(query["linuxWorkersEnabled"]) == 1 && query.Get("linuxWorkersEnabled") == "true"
	}
	if !strings.EqualFold(method, "post") || len(query) != 1 {
		return false
	}
	for _, pattern := range readOnlyRestPaths {
		if pattern.MatchString(parsed.Path) {
			return true
		}
	}
	return false
}

// ReadOnly refuses any command that is not allowlisted before it reaches next.
func ReadOnly(next Executor) Executor {
	return ExecutorFunc(func(ctx context.Context, args ...string) (Result, error) {
		if !IsReadOnly(args) {
			return Result{}, fmt.Errorf("refusing non-read-only Azure CLI command %q", CommandName(args))
		}
		return next.Run(ctx, args...)
	})
}

// CommandPath returns the leading command words before the first option.
func CommandPath(args []string) []string {
	var path []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			break
		}
		path = append(path, arg)
	}
	return path
}

// CommandName returns the space-joined command path.
func CommandName(args []string) string {
	return strings.Join(CommandPath(args), " ")
}
