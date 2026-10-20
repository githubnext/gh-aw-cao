package server

import (
	"context"
	"errors"

	"github.com/githubnext/gh-cao/server/internal/operational"
	"github.com/githubnext/gh-cao/server/internal/operational/sqlite"
)

// OpenAuditReader opens existing audit state for ListAudit and VerifyAudit.
// SQLite uses a read-only connection; PostgreSQL uses the configured evidence
// role. Neither path initializes storage or performs maintenance.
func OpenAuditReader(ctx context.Context, sqlitePath string) (operational.AuditLog, func() error, error) {
	if sqlitePath != "" {
		store, err := sqlite.OpenReadOnly(ctx, sqlitePath)
		if err != nil {
			return nil, nil, err
		}
		return store, store.Close, nil
	}
	return OpenAuditStore(ctx, "")
}

// OpenAuditStore opens the tamper-evident audit table for offline
// verification and export: the local SQLite debug file when sqlitePath is
// set, otherwise the configured operational store.
func OpenAuditStore(ctx context.Context, sqlitePath string) (operational.AuditLog, func() error, error) {
	if sqlitePath != "" {
		store, err := OpenHostedCLISQLite(ctx, sqlitePath)
		if err != nil {
			return nil, nil, err
		}
		return store, store.Close, nil
	}
	_, store, err := NewOperationalDiagnosticsFromEnv(ctx)
	if err != nil {
		return nil, nil, err
	}
	if store == nil {
		return nil, nil, errors.New("the audit table requires the postgres operational store or --sqlite")
	}
	auditStore := store.OperationalServices().Audit
	if auditStore == nil {
		_ = store.Close()
		return nil, nil, errors.New("the audit table requires the postgres operational store or --sqlite")
	}
	return auditStore, store.Close, nil
}
