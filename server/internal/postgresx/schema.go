package postgresx

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

//go:embed schema.sql
var nativeSchemaSQL string

var schemaLog = logger.New("cao:postgresx:schema")

// schemaProbe is the physical state of the connected schema, queried once per
// initialize call, so the outcome it implies is testable independently of a
// live transaction.
type schemaProbe struct {
	stateExists    bool
	contractExists bool
	storedDigest   string
	existingTables int
}

// schemaOutcome classifies which path initialize must take for a schemaProbe,
// so the contract-matching decision is a pure function that unit tests can
// exercise directly against constructed probes instead of a live database.
type schemaOutcome string

const (
	schemaOutcomeStaleWithoutContract schemaOutcome = "stale-without-contract"
	schemaOutcomeContractMismatch     schemaOutcome = "contract-mismatch"
	schemaOutcomeContractMatch        schemaOutcome = "contract-match"
	schemaOutcomeNonEmptySchema       schemaOutcome = "non-empty-schema"
	schemaOutcomeFreshSchema          schemaOutcome = "fresh-schema"
)

// classifySchemaOutcome maps a probe and the expected digest to the single
// path initialize follows: reject a pre-contract database, reject a changed
// contract, accept a matching contract, reject a non-empty fresh schema, or
// bootstrap a fresh schema. It is extracted from initialize's inline
// branching so each outcome is independently testable against constructed
// probes.
func classifySchemaOutcome(probe schemaProbe, digest string) schemaOutcome {
	switch {
	case probe.stateExists && !probe.contractExists:
		return schemaOutcomeStaleWithoutContract
	case probe.contractExists && probe.storedDigest != digest:
		return schemaOutcomeContractMismatch
	case probe.contractExists:
		return schemaOutcomeContractMatch
	case probe.existingTables != 0:
		return schemaOutcomeNonEmptySchema
	default:
		return schemaOutcomeFreshSchema
	}
}

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
	var probe schemaProbe
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass('cao_state') IS NOT NULL, to_regclass('cao_contract') IS NOT NULL`).Scan(&probe.stateExists, &probe.contractExists); err != nil {
		return err
	}
	if probe.contractExists {
		if err := tx.QueryRowContext(ctx, "SELECT digest FROM cao_contract").Scan(&probe.storedDigest); err != nil {
			return err
		}
	} else if !probe.stateExists {
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`).Scan(&probe.existingTables); err != nil {
			return err
		}
	}
	outcome := classifySchemaOutcome(probe, digest)
	schemaLog.Printf("schema initialize outcome=%s", outcome)
	switch outcome {
	case schemaOutcomeStaleWithoutContract:
		return errors.New("database is not this fresh native contract; create a new database")
	case schemaOutcomeContractMismatch:
		return errors.New("native storage contract changed; create a new database")
	case schemaOutcomeContractMatch:
		return tx.Commit()
	case schemaOutcomeNonEmptySchema:
		return errors.New("native storage requires an empty schema in a fresh database")
	case schemaOutcomeFreshSchema:
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
