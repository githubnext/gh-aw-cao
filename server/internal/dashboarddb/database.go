// Package dashboarddb defines the storage boundary for dashboard call-table
// sources. Operational state and caches are not part of this database.
package dashboarddb

import (
	"context"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// Snapshot is a complete, validated set of dashboard sources to publish.
// The backend owns atomic replacement and any indexes needed for querying.
type Snapshot struct {
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

// Database is independent of Redis generations, indexes, and projections.
// Replace must not expose a partially published snapshot to concurrent readers.
type Database interface {
	Current(context.Context) (State, error)
	Replace(context.Context, Snapshot) (State, error)
	Validate([]query.Definition) error
	Execute(context.Context, []query.Definition, []string, RuntimeSource) (map[string]model.Source, model.Metrics, error)
}
