package localops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, errors.New("command output exceeds limit")
	}
	return b.Buffer.Write(p)
}
func readCommand(ctx context.Context, options Options, limit int, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, options.GHExecutable, args...) // #nosec G204 -- trusted host executable, internal read-only argv.
	cmd.Dir = options.Workspace
	cmd.Env = commandEnvironment()
	stdout := &boundedBuffer{limit: limit}
	stderr := &boundedBuffer{limit: 16 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	configureProcess(cmd)
	cmd.Cancel = func() error { return killProcess(cmd) }
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		return nil, errors.New("github CLI request failed")
	}
	return stdout.Bytes(), nil
}
func commandEnvironment() []string {
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GH_PAGER", "PAGER", "GH_PROMPT_DISABLED":
			continue
		}
		env = append(env, entry)
	}
	return append(env, "GH_PAGER=cat", "PAGER=cat", "GH_PROMPT_DISABLED=1")
}

func terminalEnvironment(environment []string) []string {
	terminalKeys := map[string]bool{"NO_COLOR": true, "TERM": true, "COLORTERM": true, "CLICOLOR": true, "CLICOLOR_FORCE": true, "FORCE_COLOR": true, "GH_FORCE_TTY": true}
	result := make([]string, 0, len(environment)+7)
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		if !terminalKeys[key] {
			result = append(result, entry)
		}
	}
	return append(result, "TERM=xterm-256color", "COLORTERM=truecolor", "CLICOLOR=1", "CLICOLOR_FORCE=1", "FORCE_COLOR=3", "GH_FORCE_TTY=80")
}

// ExecuteCommand executes a validated argv command; no shell or JavaScript
// runtime is involved. Empty input denotes no stdin.
func ExecuteCommand(ctx context.Context, workspace, ghExecutable, command, input string, output func(stream, data string)) (map[string]any, error) {
	if utf8.RuneCountInString(input) > 100000 {
		return nil, failure(400, "CLI action input exceeds its character limit.")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if ghExecutable == "" {
		ghExecutable = "gh"
	}
	var stdin *string
	if input != "" {
		stdin = &input
	}
	emitted := 0
	return executeCommand(ctx, Options{Workspace: workspace, GHExecutable: ghExecutable, OperatorExecutable: executable}, Invocation{Command: command, Input: stdin}, func(stream, data string) error {
		if len(data) > 1<<20-emitted {
			return errors.New("the CLI action exceeded its output buffer limit")
		}
		emitted += len(data)
		if output != nil {
			output(stream, data)
		}
		return nil
	})
}
func executeCommand(ctx context.Context, options Options, invocation Invocation, output func(string, string) error) (map[string]any, error) {
	tokens, err := ParseCommand(invocation.Command)
	if err != nil {
		return nil, err
	}
	if (invocation.Input != nil) != (invocation.Command == "gh agent-task create --from-file -") {
		return nil, failure(400, "CLI action input is not valid for this command.")
	}
	command, args := options.GHExecutable, tokens[1:]
	operator := tokens[0] == "./cao.sh" || tokens[0] == "gh-cao" || tokens[0] == "gh" && tokens[1] == "cao"
	ghAW := tokens[0] == "gh" && tokens[1] == "aw"
	env := commandEnvironment()
	token := os.Getenv("GH_TOKEN")
	if token == "" {
		token = os.Getenv("GITHUB_TOKEN")
	}
	if token == "" {
		raw, tokenErr := readCommand(ctx, options, 16<<10, "auth", "token", "--hostname", githubHost())
		if tokenErr != nil {
			return nil, errors.New("authenticate GitHub CLI before running dashboard actions")
		}
		token = strings.TrimSpace(string(raw))
	}
	if token == "" || strings.IndexFunc(token, func(char rune) bool { return unicode.IsSpace(char) || unicode.IsControl(char) }) >= 0 {
		return nil, errors.New("github CLI authentication token is invalid")
	}
	if options.onCredential != nil {
		options.onCredential(token)
	}
	filtered := make([]string, 0, len(env)+1)
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(key, "GH_TOKEN") {
			filtered = append(filtered, entry)
		}
	}
	filtered = append(filtered, "GH_TOKEN="+token)
	env = filtered
	if operator {
		args = nativeOperatorArguments(tokens)
		if options.OperatorExecutable != "" {
			command = options.OperatorExecutable
		} else {
			args = append([]string{"cao"}, args...)
		}
	}
	if command == "" {
		return nil, errors.New("operator executable is unavailable")
	}
	if ghAW {
		compiler, err := ensureGhAW(ctx, options)
		if err != nil {
			return nil, err
		}
		if compiler != "" {
			command, args = compiler, tokens[2:]
		}
	}
	if operator || ghAW {
		identity, e := readCommand(ctx, options, 64<<10, "api", "--hostname", githubHost(), "--method", "GET", "user")
		if e != nil {
			return nil, errors.New("could not determine the current GitHub CLI user for Git commit attribution")
		}
		var user struct {
			ID                 int64 `json:"id"`
			Login, Name, Email string
		}
		if json.Unmarshal(identity, &user) != nil || user.ID <= 0 || user.Login == "" {
			return nil, errors.New("the current GitHub CLI user does not provide a valid login and user ID")
		}
		if user.Name == "" {
			user.Name = user.Login
		}
		if user.Email == "" {
			user.Email = strconv.FormatInt(user.ID, 10) + "+" + user.Login + "@users.noreply.github.com"
		}
		if strings.ContainsAny(user.Name+user.Email, "\x00\r\n") {
			return nil, errors.New("invalid GitHub CLI user identity")
		}
		env = append(env, "GIT_AUTHOR_NAME="+user.Name, "GIT_COMMITTER_NAME="+user.Name, "GIT_AUTHOR_EMAIL="+user.Email, "GIT_COMMITTER_EMAIL="+user.Email)
	}
	cmd := exec.CommandContext(ctx, command, args...) // #nosec G204 -- ResolveAction and ParseCommand restrict executable and argv; no shell.
	cmd.Dir = options.Workspace
	cmd.Env = env
	cmd.WaitDelay = 2 * time.Second
	configureProcess(cmd)
	cmd.Cancel = func() error { return killProcess(cmd) }
	terminal := invocation.Input == nil && (operator || ghAW)
	if terminal {
		cmd.Env = terminalEnvironment(cmd.Env)
		return executeTerminal(ctx, cmd, output)
	}
	if invocation.Input != nil {
		cmd.Stdin = strings.NewReader(*invocation.Input)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	prepareExecution(cmd)
	if err = cmd.Start(); err != nil {
		return nil, errors.New("the CLI action executable is unavailable")
	}
	cleanup, err := resumeExecution(cmd)
	if err != nil {
		_ = killProcess(cmd)
		_ = cmd.Wait()
		return nil, errors.New("the CLI action process isolation is unavailable")
	}
	defer cleanup()
	var wg sync.WaitGroup
	var writeMu sync.Mutex
	var outputErr error
	pump := func(stream string, r io.Reader) {
		defer wg.Done()
		buffer := make([]byte, 8<<10)
		for {
			n, e := r.Read(buffer)
			if n > 0 {
				writeMu.Lock()
				if outputErr == nil && output != nil {
					outputErr = output(stream, string(buffer[:n]))
					if outputErr != nil {
						_ = killProcess(cmd)
					}
				}
				writeMu.Unlock()
			}
			if e != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump("stdout", stdout)
	go pump("stderr", stderr)
	wg.Wait()
	err = cmd.Wait()
	// Kill any surviving descendants that inherited the subprocess group.
	_ = killProcess(cmd)
	return commandResult(ctx, cmd, err, outputErr)
}

func commandResult(ctx context.Context, cmd *exec.Cmd, executionErr, outputErr error) (map[string]any, error) {
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	result := map[string]any{"ok": executionErr == nil && outputErr == nil && ctx.Err() == nil, "exitCode": code}
	if result["ok"] != true {
		result["error"] = "The CLI action did not complete successfully."
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if outputErr != nil {
		return result, errors.New("the CLI action output could not be persisted")
	}
	return result, nil
}

var compilerVersionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
var compilerInstallation = make(chan struct{}, 1)

func ensureGhAW(ctx context.Context, options Options) (string, error) {
	select {
	case compilerInstallation <- struct{}{}:
		defer func() { <-compilerInstallation }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if _, err := readCommand(ctx, options, 64<<10, "aw", "--help"); err == nil {
		return "", nil
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(options.Workspace, ".github", "workflows", "cao.json"))
	if err != nil {
		return "", errors.New("could not read the gh-aw compiler version from .github/workflows/cao.json")
	}
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil || !compilerVersionPattern.MatchString(text(config["gh-aw-version"])) {
		return "", errors.New("the gh-aw compiler version in .github/workflows/cao.json is invalid")
	}
	version := text(config["gh-aw-version"])
	cache, err := compilerCache(options.Workspace, version)
	if err != nil {
		return "", err
	}
	if ready, err := verifiedCompilerCache(cache); err != nil || ready {
		return cache, err
	}
	if _, err = readCommand(ctx, options, 1<<20, "extension", "install", "github/gh-aw", "--pin", version); err == nil {
		if _, err = readCommand(ctx, options, 64<<10, "aw", "--help"); err == nil {
			return "", nil
		}
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	return downloadCompiler(ctx, options, version, cache)
}

type outputFrames struct {
	mu                sync.Mutex
	buffers           map[string]string
	dropping, private map[string]bool
	persist           func(string, string) error
	truncated         func()
	err               error
}

func newOutputFrames(persist func(string, string) error, truncated func()) *outputFrames {
	return &outputFrames{buffers: map[string]string{}, dropping: map[string]bool{}, private: map[string]bool{}, persist: persist, truncated: truncated}
}
func (f *outputFrames) line(stream, line string) error {
	if strings.Contains(line, "-----BEGIN ") && strings.Contains(line, "PRIVATE KEY-----") {
		f.private[stream] = true
	}
	if f.private[stream] {
		if strings.Contains(line, "-----END ") && strings.Contains(line, "PRIVATE KEY-----") {
			f.private[stream] = false
		}
		line = "[REDACTED]\n"
	}
	if line != "" {
		return f.persist(stream, line)
	}
	return nil
}
func (f *outputFrames) write(stream, data string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	for len(data) > 0 {
		end := strings.IndexAny(data, "\r\n")
		stop := len(data)
		if end >= 0 {
			stop = end + 1
		}
		if !f.dropping[stream] {
			if len(f.buffers[stream])+stop > 16<<10 {
				f.buffers[stream] = ""
				f.dropping[stream] = true
				f.truncated()
			} else {
				f.buffers[stream] += data[:stop]
			}
		}
		if end >= 0 {
			if !f.dropping[stream] {
				if f.err = f.line(stream, f.buffers[stream]); f.err != nil {
					return f.err
				}
			}
			f.buffers[stream] = ""
			f.dropping[stream] = false
		}
		data = data[stop:]
	}
	return nil
}
func (f *outputFrames) flush() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, stream := range []string{"stdout", "stderr"} {
		if !f.dropping[stream] && f.err == nil {
			f.err = f.line(stream, f.buffers[stream])
		}
		f.buffers[stream] = ""
	}
}

func localQuotaBypass(command string) bool {
	tokens, err := ParseCommand(command)
	if err != nil || len(tokens) < 3 || tokens[0] != "gh" || tokens[1] != "aw" {
		return false
	}
	if len(tokens) == 3 {
		switch tokens[2] {
		case "help", "--help", "version", "--version":
			return true
		}
	}
	if tokens[2] != "compile" {
		return false
	}
	for _, arg := range tokens[3:] {
		if strings.HasPrefix(arg, "-R") || strings.HasPrefix(arg, "--repo") || strings.HasPrefix(arg, "--check-update") {
			return false
		}
	}
	return true
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
