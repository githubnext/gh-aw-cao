// Package dashboarddb defines the storage boundary for dashboard call-table
// sources. Operational state and caches are not part of this database.
package dashboarddb

import (
	"context"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// Transactions is the data supplied to a dashboard database ingestion.
// The backend owns how the data is persisted and made available to readers.
type Transactions struct {
	DataRevision     string
	EvaluatedAt      time.Time
	Sources          map[string]model.Source
	Diagnostics      model.Diagnostics
	RepositoryMemory []byte
	MemoryFiles      map[string][]byte
}

type State struct {
	Revision     int64
	DataRevision string
	EvaluatedAt  time.Time
	Counts       map[string]int
	Available    bool
}

// RuntimeSource resolves sources that are not stored in the dashboard database.
// The bool reports whether the source was handled.
type RuntimeSource func(string, *query.Definition) (model.Source, model.Metrics, bool, error)

// Reader pins one published snapshot so its state and query results agree,
// even when a replacement is published during a request.
type Reader interface {
	State() State
	Execute(context.Context, []query.Definition, []string, RuntimeSource) (map[string]model.Source, model.Metrics, error)
}

// Database is independent of Redis generations, indexes, and projections.
// Ingest must not expose partially ingested data to concurrent readers.
type Database interface {
	Current(context.Context) (Reader, error)
	Ingest(context.Context, Transactions) (State, error)
	Validate(context.Context, []query.Definition) error
}
