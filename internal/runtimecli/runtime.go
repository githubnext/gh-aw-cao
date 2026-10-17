// Package runtimecli connects operator commands to the installed CAO domain runtime.
package runtimecli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ExitError carries a status whose diagnostic has already been streamed.
type ExitError struct {
	Code int
}

func (e *ExitError) Error() string {
	return fmt.Sprintf("CAO runtime exited with status %d", e.Code)
}

// Resolve locates a repository-local runtime, never downloading or installing code.
// An explicit root takes precedence and must not silently fall back.
func Resolve(directory, explicitRoot, executable string) (string, error) {
	if explicitRoot != "" {
		root, err := filepath.Abs(explicitRoot)
		if err != nil {
			return "", err
		}
		return entrypoint(root)
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	for {
		entry, err := entrypoint(root)
		if err == nil {
			return entry, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		_, err = os.Lstat(filepath.Join(root, ".git"))
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(root)
		if parent == root {
			break
		}
		root = parent
	}
	if executable != "" {
		resolved, err := filepath.EvalSymlinks(executable)
		if err != nil {
			return "", err
		}
		entry, err := entrypoint(filepath.Dir(resolved))
		if err == nil {
			return entry, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	return "", errors.New("CAO operator runtime is unavailable; install the CAO root campaign in this checkout or set CAO_RUNTIME_ROOT to an installed CAO runtime")
}

func entrypoint(root string) (string, error) {
	entry := filepath.Join(root, "activity", "cao.mjs")
	info, err := os.Stat(entry)
	if err != nil {
		return "", fmt.Errorf("CAO runtime at %s: %w", root, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("CAO runtime entry point is not a regular file: %s", entry)
	}
	return entry, nil
}

func Execute(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	directory, err := os.Getwd()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	entry, err := Resolve(directory, os.Getenv("CAO_RUNTIME_ROOT"), executable)
	if err != nil {
		return err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return fmt.Errorf("CAO operator runtime requires Node.js 24 or newer on PATH: %w", err)
	}
	if err := checkNode(ctx, node); err != nil {
		return err
	}
	return run(ctx, node, append([]string{entry}, args...), stdin, stdout, stderr)
}

func checkNode(ctx context.Context, node string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, node, "--version").Output()
	if err != nil {
		return fmt.Errorf("check Node.js version: %w", err)
	}
	version := strings.TrimSpace(string(output))
	major, _, _ := strings.Cut(strings.TrimPrefix(version, "v"), ".")
	number, err := strconv.Atoi(major)
	if err != nil || number < 24 {
		return fmt.Errorf("CAO operator runtime requires Node.js 24 or newer; found %q", version)
	}
	return nil
}

func run(ctx context.Context, executable string, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	configureProcess(cmd)
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		if cleanupErr := stopProcessTree(cmd); cleanupErr != nil {
			if _, writeErr := fmt.Fprintln(stderr, "error: unable to stop CAO runtime subprocesses:", cleanupErr); writeErr != nil {
				return errors.Join(ctx.Err(), cleanupErr, writeErr)
			}
		}
		return ctx.Err()
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code := exit.ExitCode()
		if code < 1 {
			code = 1
		}
		return &ExitError{Code: code}
	}
	if err != nil {
		return fmt.Errorf("start CAO operator runtime: %w", err)
	}
	return nil
}
