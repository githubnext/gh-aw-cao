package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-cao/server/internal/auditlifecycle"
	debuglogger "github.com/githubnext/gh-cao/server/internal/logger"
	"github.com/githubnext/gh-cao/server/internal/server"
)

var auditLifecyclesLog = debuglogger.New("cao:dashboard:audit-lifecycles")

const (
	minLifecycleTimeout = time.Second
	maxLifecycleTimeout = 30 * time.Minute
)

// validateLifecycleTimeout bounds the whole-invocation deadline.
func validateLifecycleTimeout(timeout time.Duration) error {
	if timeout < minLifecycleTimeout || timeout > maxLifecycleTimeout {
		return errors.New("audit lifecycle timeout must be between 1s and 30m")
	}
	return nil
}

// lifecycleOutcome maps a scan result to the command error: a scan error wins,
// and any status other than "ok" requires operator attention.
func lifecycleOutcome(result auditlifecycle.Result, scanErr error) error {
	if scanErr != nil {
		auditLifecyclesLog.Printf("lifecycle scan failed: scanned=%d", result.Scanned)
		return scanErr
	}
	if result.Status != "ok" {
		auditLifecyclesLog.Printf("lifecycle scan needs attention: status=%s scanned=%d missing_terminal=%d", result.Status, result.Scanned, result.MissingTerminal)
		return errors.New("audit lifecycle evidence requires operator attention; inspect the JSON result")
	}
	auditLifecyclesLog.Printf("lifecycle scan ok: scanned=%d completed=%d pending=%d", result.Scanned, result.Completed, result.Pending)
	return nil
}

func newAuditLifecyclesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "lifecycles",
		Short: "read-only bounded check for missing administrative rebuild terminal evidence",
		Args:  cobra.NoArgs,
	}
	sqlitePath := cmd.Flags().String("sqlite", "", "local debugging only: existing SQLite audit file")
	after := cmd.Flags().Int64("after", 0, "scan a selected suffix; earlier lifecycle evidence remains unknown")
	maxEvents := cmd.Flags().Int("max-events", 10000, "maximum rows scanned, plus one lookahead (1-100000)")
	grace := cmd.Flags().Duration("grace", auditlifecycle.DefaultGrace, "minimum age before missing-terminal alert (35m-168h)")
	timeout := cmd.Flags().Duration("timeout", 2*time.Minute, "whole invocation deadline (1s-30m)")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		options := auditlifecycle.Options{AfterSequence: *after, MaxEvents: *maxEvents, Grace: *grace, Now: time.Now()}
		if err := options.Validate(); err != nil {
			return err
		}
		if err := validateLifecycleTimeout(*timeout); err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		ctx, cancel := context.WithTimeout(ctx, *timeout)
		defer cancel()
		// Unlike audit verify, this path never records its own outcome.
		store, closeStore, err := server.OpenAuditReader(ctx, *sqlitePath)
		if err != nil {
			return errors.New("audit lifecycle scan could not open the configured audit reader")
		}
		defer func() { _ = closeStore() }()
		result, scanErr := auditlifecycle.Scan(ctx, store, options)
		if err := json.NewEncoder(cmd.OutOrStdout()).Encode(result); err != nil {
			return errors.New("audit lifecycle scan could not write its operational result")
		}
		return lifecycleOutcome(result, scanErr)
	}
	return cmd
}
