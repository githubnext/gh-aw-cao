package postgresx

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"strings"
)

//go:embed schema.sql
var nativeSchemaSQL string

func initialize(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(712083241, 17483)`); err != nil {
		return err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(nativeSchemaSQL)))
	var stateExists, contractExists bool
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass('cao_state') IS NOT NULL, to_regclass('cao_contract') IS NOT NULL`).Scan(&stateExists, &contractExists); err != nil {
		return err
	}
	if stateExists && !contractExists {
		return errors.New("database is not this fresh native contract; create a new database")
	}
	if contractExists {
		var stored string
		if err := tx.QueryRowContext(ctx, "SELECT digest FROM cao_contract").Scan(&stored); err != nil {
			return err
		}
		if stored != digest {
			return errors.New("native storage contract changed; create a new database")
		}
		return tx.Commit()
	}
	var existingTables int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`).Scan(&existingTables); err != nil {
		return err
	}
	if existingTables != 0 {
		return errors.New("native storage requires an empty schema in a fresh database")
	}
	for _, statement := range strings.Split(nativeSchemaSQL, ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO cao_contract(digest) VALUES($1)", digest); err != nil {
		return err
	}
	return tx.Commit()
}
