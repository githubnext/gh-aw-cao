package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/sqlite"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

// Database commands take an explicit store and PostgreSQL namespace or local
// SQLite file, never administrator credentials from runtime policy.
func newDatabaseCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "database", Short: "explicit PostgreSQL or local SQLite provisioning and maintenance"}
	for _, action := range []string{"bootstrap", "maintain", "retain-audit"} {
		cmd.AddCommand(newDatabaseAction(action))
	}
	return cmd
}

func newDatabaseAction(action string) *cobra.Command {
	cmd := &cobra.Command{Use: action, Short: "run database " + action + " with separately supplied credentials", Args: cobra.NoArgs}
	storeKind := cmd.Flags().String("store", "", "canonical or operational (required)")
	namespace := cmd.Flags().String("namespace", "", "exact deployment namespace (required for PostgreSQL)")
	sqlitePath := cmd.Flags().String("sqlite", "", "local debugging only: hosted CLI SQLite file instead of PostgreSQL")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if *storeKind != "canonical" && *storeKind != "operational" {
			return errors.New("--store must be canonical or operational")
		}
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		var removed int64
		var err error
		backend := "postgres"
		if cmd.Flags().Changed("sqlite") {
			if strings.TrimSpace(*sqlitePath) == "" {
				return errors.New("--sqlite requires a local database file path")
			}
			if *storeKind != "operational" || action == "maintain" {
				return errors.New("--sqlite supports operational bootstrap and retain-audit only; canonical storage requires PostgreSQL")
			}
			if cmd.Flags().Changed("namespace") {
				return errors.New("--namespace is not supported with --sqlite; use a separate file for each local deployment")
			}
			backend = "sqlite"
			removed, err = runSQLiteDatabaseAction(ctx, *sqlitePath, action)
		} else {
			if strings.TrimSpace(*namespace) == "" {
				return errors.New("--namespace is required")
			}
			if (action == "maintain" && *storeKind != "canonical") || (action == "retain-audit" && *storeKind != "operational") {
				return errors.New("maintain requires canonical storage; retain-audit requires operational storage")
			}
			dsn := strings.TrimSpace(os.Getenv("CAO_DATABASE_ADMIN_URL"))
			if dsn == "" {
				return errors.New("CAO_DATABASE_ADMIN_URL is required; do not mount it in runtime processes")
			}
			removed, err = runDatabaseAction(ctx, dsn, *storeKind, *namespace, action)
		}
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"action": action, "store": *storeKind, "backend": backend, "audit_events_removed": removed})
	}
	return cmd
}

func runSQLiteDatabaseAction(ctx context.Context, path, action string) (int64, error) {
	open := sqlite.OpenExisting
	switch action {
	case "bootstrap":
		open = sqlite.New
	case "retain-audit":
	default:
		return 0, errors.New("unsupported SQLite database action")
	}
	store, err := open(ctx, path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = store.Close() }()
	if action == "retain-audit" {
		return store.RetainAudit(ctx)
	}
	return 0, nil
}

func runDatabaseAction(ctx context.Context, dsn, kind, namespace, action string) (int64, error) {
	if kind == "canonical" {
		// New validates the immutable canonical contract, provisions the full
		// historical/upcoming window, and retires expired weekly partitions.
		store, err := postgresx.NewWithNamespace(ctx, dsn, namespace)
		if err != nil {
			return 0, err
		}
		return 0, store.Close()
	}
	config, err := server.PostgresOperationalConfigFromEnv()
	if err != nil {
		return 0, err
	}
	open := postgres.Open
	if action == "bootstrap" {
		open = postgres.New
	}
	store, err := open(ctx, dsn, namespace, config)
	if err != nil {
		return 0, err
	}
	defer func() { _ = store.Close() }()
	if action == "retain-audit" {
		return store.RetainAudit(ctx)
	}
	return 0, nil
}
