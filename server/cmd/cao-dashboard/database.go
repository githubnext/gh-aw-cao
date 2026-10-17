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
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

// Database commands deliberately take an explicit store and namespace. They
// never obtain administrator credentials from the runtime policy or listener.
func newDatabaseCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "database", Short: "explicit PostgreSQL provisioning and maintenance"}
	for _, action := range []string{"bootstrap", "maintain", "retain-audit"} {
		cmd.AddCommand(newDatabaseAction(action))
	}
	return cmd
}

func newDatabaseAction(action string) *cobra.Command {
	cmd := &cobra.Command{Use: action, Short: "run database " + action + " with separately supplied credentials", Args: cobra.NoArgs}
	storeKind := cmd.Flags().String("store", "", "canonical or operational (required)")
	namespace := cmd.Flags().String("namespace", "", "exact existing deployment namespace (required)")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if *storeKind != "canonical" && *storeKind != "operational" {
			return errors.New("--store must be canonical or operational")
		}
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
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		removed, err := runDatabaseAction(ctx, dsn, *storeKind, *namespace, action)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"action": action, "store": *storeKind, "audit_events_removed": removed})
	}
	return cmd
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
