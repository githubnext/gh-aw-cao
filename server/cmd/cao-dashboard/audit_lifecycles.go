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

func validateLifecycleTimeout(timeout time.Duration) error {
	if timeout < time.Second || timeout > 30*time.Minute {
		return errors.New("audit lifecycle timeout must be between 1s and 30m")
	}
	return nil
}

// lifecycleOutcome maps a completed scan to the command error: a scan error
// wins, then any non-ok status requires operator attention.
func lifecycleOutcome(result auditlifecycle.Result, scanErr error) error {
	auditLifecyclesLog.Printf("audit lifecycle scan finished: status=%s scan_failed=%t", result.Status, scanErr != nil)
	if scanErr != nil {
		return scanErr
	}
	if result.Status != "ok" {
		return errors.New("audit lifecycle evidence requires operator attention; inspect the JSON result")
	}
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
