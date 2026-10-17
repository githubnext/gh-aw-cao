package ghcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	gh "github.com/cli/go-gh/v2"
	"github.com/github/gh-aw/pkg/logger"
)

var log = logger.New("cao:gh")

func Exec(ctx context.Context, args ...string) (string, string, error) {
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
