package ghcli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"

	gh "github.com/cli/go-gh/v2"
)

// ExecBounded reads at most limit stdout bytes and never returns subprocess diagnostics.
func ExecBounded(ctx context.Context, limit int, args ...string) (string, error) {
	binary, err := gh.Path()
	if err != nil {
		return "", errors.New("GitHub CLI is unavailable")
	}
	return execBounded(ctx, binary, limit, args...)
}

func execBounded(ctx context.Context, binary string, limit int, args ...string) (string, error) {
	if limit <= 0 {
		return "", errors.New("GitHub output limit must be positive")
	}
	child := exec.CommandContext(ctx, binary, args...)
	child.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_PAGER=cat")
	if directory, ok := ctx.Value(directoryKey{}).(string); ok {
		child.Dir = directory
	}
	output := boundedOutput{limit: limit}
	child.Stdout, child.Stderr = &output, io.Discard
	err := child.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if output.exceeded {
		return "", errors.New("GitHub output exceeds " + strconv.Itoa(limit) + " bytes")
	}
	if err != nil {
		// Neither stderr nor exec errors may expose credentials or response bodies.
		return "", errors.New("GitHub command failed; subprocess diagnostics withheld")
	}
	return output.String(), nil
}

type boundedOutput struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

func (b *boundedOutput) Write(value []byte) (int, error) {
	if len(value) > b.limit-b.buffer.Len() {
		b.exceeded = true
		return 0, errors.New("output bound exceeded")
	}
	return b.buffer.Write(value)
}

func (b *boundedOutput) String() string {
	return b.buffer.String()
}
