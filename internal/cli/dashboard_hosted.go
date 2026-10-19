package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

type dashboardHostedOptions struct {
	Workspace, Catalog, Store, Policy, Site, Host, Certificate, Key string
	Port                                                            int
}

func runDashboardHosted(ctx context.Context, cmd *cobra.Command, options dashboardHostedOptions) (err error) {
	if (options.Certificate == "") != (options.Key == "") {
		return errors.New("--cert and --key must be provided together")
	}
	root := options.Catalog
	if root == "" {
		root = options.Workspace
	}
	absolute := func(path string) string {
		if filepath.IsAbs(path) {
			return path
		}
		return filepath.Join(options.Workspace, path)
	}
	root = absolute(root)
	policy := strings.TrimSpace(options.Policy)
	if policy == "" {
		policy = strings.TrimSpace(os.Getenv("CAO_POLICY_PATH"))
	}
	if policy == "" {
		policy = strings.TrimSpace(os.Getenv("CAO_MARKETPLACE_POLICY_PATH"))
	}
	if policy == "" {
		policy = filepath.Join(root, ".github", "workflows", "cao.json")
	}
	site := options.Site
	if site == "" {
		site = filepath.Join(root, "dashboard", "site", "dist")
	}
	directory, err := os.MkdirTemp("", "cao-dashboard-hosted-")
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, os.RemoveAll(directory)) }()
	executable := os.Getenv("CAO_DASHBOARD_EXECUTABLE")
	run := func(executable string, args ...string) error {
		child := exec.CommandContext(ctx, executable, args...)
		child.Dir = root
		child.Env = append(os.Environ(), "CAO_POLICY_PATH="+absolute(policy))
		child.Stdin, child.Stdout, child.Stderr = cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr()
		child.Cancel = func() error { return child.Process.Signal(syscall.SIGTERM) }
		child.WaitDelay = 7 * time.Second
		err := child.Run()
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	if executable == "" {
		if info, err := os.Stat(filepath.Join(root, "server", "go.mod")); err != nil || !info.Mode().IsRegular() {
			return errors.New("hosted mode requires --catalog pointing to the Go server source, or CAO_DASHBOARD_EXECUTABLE")
		}
		executable = filepath.Join(directory, "cao-dashboard")
		if runtime.GOOS == "windows" {
			executable += ".exe"
		}
		if err := run("go", "-C", filepath.Join(root, "server"), "build", "-o", executable, "./cmd/cao-dashboard"); err != nil {
			return fmt.Errorf("build hosted Go server: %w", err)
		}
		if ctx.Err() != nil {
			return nil
		}
	}
	args := []string{"serve-hosted", "--operational-store", options.Store,
		"--listen", fmt.Sprintf("%s:%d", bracketDashboardHost(options.Host), options.Port),
		"--site", absolute(site)}
	if options.Certificate != "" {
		args = append(args, "--cert", absolute(options.Certificate), "--key", absolute(options.Key))
	}
	return run(executable, args...)
}

func bracketDashboardHost(host string) string {
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}
