package postgresx

import (
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestClassifySchemaOutcomeStaleWithoutContract(t *testing.T) {
	outcome := classifySchemaOutcome(schemaProbe{stateExists: true, contractExists: false}, "digest")
	if outcome != schemaOutcomeStaleWithoutContract {
		t.Fatalf("expected stale-without-contract, got %s", outcome)
	}
}

func TestClassifySchemaOutcomeContractMismatch(t *testing.T) {
	probe := schemaProbe{contractExists: true, storedDigest: "old"}
	outcome := classifySchemaOutcome(probe, "new")
	if outcome != schemaOutcomeContractMismatch {
		t.Fatalf("expected contract-mismatch, got %s", outcome)
	}
}

func TestClassifySchemaOutcomeContractMatch(t *testing.T) {
	probe := schemaProbe{contractExists: true, storedDigest: "same"}
	outcome := classifySchemaOutcome(probe, "same")
	if outcome != schemaOutcomeContractMatch {
		t.Fatalf("expected contract-match, got %s", outcome)
	}
}

func TestClassifySchemaOutcomeNonEmptySchema(t *testing.T) {
	probe := schemaProbe{existingTables: 3}
	outcome := classifySchemaOutcome(probe, "digest")
	if outcome != schemaOutcomeNonEmptySchema {
		t.Fatalf("expected non-empty-schema, got %s", outcome)
	}
}

func TestClassifySchemaOutcomeFreshSchema(t *testing.T) {
	outcome := classifySchemaOutcome(schemaProbe{}, "digest")
	if outcome != schemaOutcomeFreshSchema {
		t.Fatalf("expected fresh-schema, got %s", outcome)
	}
}

// schemaTestSchema creates an isolated Postgres schema for initialize's
// live-database branches, following the same pattern as nativeTestStore, but
// exercising initialize directly instead of through NewConfig so the
// contract-rejection paths are reachable without a full Store.
func schemaTestSchema(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	endpoint := os.Getenv("POSTGRES_URL")
	if endpoint == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	schema := fmt.Sprintf("cao_schema_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(t.Context(), "CREATE SCHEMA "+schema); err != nil {
		_ = admin.Close()
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*config)
	cleanup := func() {
		_ = db.Close()
		_, _ = admin.ExecContext(t.Context(), "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close()
	}
	return db, cleanup
}

func TestInitializeBootstrapsFreshSchemaThenAcceptsMatchingReopen(t *testing.T) {
	db, cleanup := schemaTestSchema(t)
	defer cleanup()
	if err := initialize(t.Context(), db); err != nil {
		t.Fatalf("fresh schema bootstrap failed: %v", err)
	}
	var contractCount int
	if err := db.QueryRowContext(t.Context(), "SELECT count(*) FROM cao_contract").Scan(&contractCount); err != nil || contractCount != 1 {
		t.Fatalf("expected exactly one contract row, count=%d err=%v", contractCount, err)
	}
	if err := initialize(t.Context(), db); err != nil {
		t.Fatalf("reopen with matching contract must succeed: %v", err)
	}
}

func TestInitializeRejectsChangedContract(t *testing.T) {
	db, cleanup := schemaTestSchema(t)
	defer cleanup()
	if err := initialize(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), "UPDATE cao_contract SET digest='changed'"); err != nil {
		t.Fatal(err)
	}
	if err := initialize(t.Context(), db); err == nil {
		t.Fatal("changed contract digest must be rejected")
	}
}

func TestInitializeRejectsNonEmptySchemaWithoutContract(t *testing.T) {
	for _, table := range []string{"stray_table", "cao_operational_cli_unknown"} {
		t.Run(table, func(t *testing.T) {
			db, cleanup := schemaTestSchema(t)
			defer cleanup()
			if _, err := db.ExecContext(t.Context(), "CREATE TABLE "+table+" (id int)"); err != nil {
				t.Fatal(err)
			}
			if err := initialize(t.Context(), db); err == nil {
				t.Fatal("non-empty schema without a contract must be rejected")
			}
		})
	}
}

func TestInitializePreservesHostedExecutionTable(t *testing.T) {
	db, cleanup := schemaTestSchema(t)
	defer cleanup()
	if _, err := db.ExecContext(t.Context(), "CREATE TABLE cao_operational_cli_executions (command_id bigint PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), "INSERT INTO cao_operational_cli_executions VALUES (42)"); err != nil {
		t.Fatal(err)
	}
	if err := initialize(t.Context(), db); err != nil {
		t.Fatalf("hosted execution state blocked canonical initialization: %v", err)
	}
	var id int64
	if err := db.QueryRowContext(t.Context(), "SELECT command_id FROM cao_operational_cli_executions").Scan(&id); err != nil || id != 42 {
		t.Fatalf("canonical initialization changed hosted execution state: id=%d, err=%v", id, err)
	}
}
