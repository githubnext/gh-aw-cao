package ghcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	gh "github.com/cli/go-gh/v2"
	"github.com/github/gh-aw/pkg/logger"
)

var log = logger.New("cao:gh")

type directoryKey struct{}

// WithDirectory scopes a child command without changing the process directory.
func WithDirectory(ctx context.Context, directory string) context.Context {
	return context.WithValue(ctx, directoryKey{}, directory)
}

func Exec(ctx context.Context, args ...string) (string, string, error) {
	if directory, ok := ctx.Value(directoryKey{}).(string); ok {
		binary, err := gh.Path()
		if err != nil {
			return "", "", err
		}
		child := exec.CommandContext(ctx, binary, args...)
		child.Dir = directory
		var stdout, stderr bytes.Buffer
		child.Stdout, child.Stderr = &stdout, &stderr
		err = child.Run()
		return stdout.String(), stderr.String(), err
	}
	stdout, stderr, err := gh.ExecContext(ctx, args...)
	return stdout.String(), stderr.String(), err
}

func Version(ctx context.Context) (string, error) {
	return version(ctx, gh.ExecContext)
}

func version(ctx context.Context, exec func(context.Context, ...string) (bytes.Buffer, bytes.Buffer, error)) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	log.Print("Checking the local GitHub CLI version")
	stdout, _, err := exec(ctx, "--version")
	if err != nil {
		return "", fmt.Errorf("check GitHub CLI (install gh and ensure it is on PATH): %w", err)
	}
	result := strings.TrimSpace(stdout.String())
	if result == "" {
		return "", errors.New("GitHub CLI returned an empty version")
	}
	return result, nil
}
