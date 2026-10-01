// Package dashboarddb defines the persistence and query boundary for dashboard
// data. Operational state (sessions, queues, counters and caches) stays in Redis.
package dashboarddb

import (
	"context"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

// Storage stages complete generations and activates them only after ingestion
// succeeds. Implementations must preserve the previous active generation on
// staging or activation failure.
type Storage interface {
	Active(context.Context) (model.ActiveGeneration, error)
	TrackGeneration(context.Context, string) error
	DiscardGeneration(context.Context, string) error
	PutSource(context.Context, string, model.Source) error
	PutDiagnostics(context.Context, string, model.Diagnostics) error
	Diagnostics(context.Context, string) (model.Diagnostics, error)
	PutRepositoryMemory(context.Context, string, []byte, map[string][]byte) error
	RepositoryMemoryManifest(context.Context, string) ([]byte, error)
	RepositoryMemoryFile(context.Context, string, string, string) ([]byte, error)
	Activate(context.Context, string, string, time.Time, map[string]int) (int64, error)
	PruneGenerations(context.Context, int) (int, error)
}

// IssueUpdates applies status overlays only to issues retained in the active
// dashboard generation.
type IssueUpdates interface {
	ApplyIssueUpdate(context.Context, redisx.IssueUpdate, time.Duration) (bool, bool, int64, error)
}

// Database owns dashboard storage and the validation and execution of
// Dashboard Language queries. The loader can supply request-scoped runtime
// sources without persisting them in the dashboard database.
type Database interface {
	Storage
	LoadSource(context.Context, string, string, *query.Definition) (model.Source, model.Metrics, error)
	ApplyIssueUpdate(context.Context, redisx.IssueUpdate, time.Duration) (bool, bool, int64, error)
	ValidateQueries([]query.Definition) error
	ExecuteQueries([]query.Definition, []string, query.Loader) (map[string]model.Source, model.Metrics, error)
}

// Redis implements Database using the existing generation-scoped Redis store.
// The same store remains available separately for operational features.
type Redis struct {
	*redisx.Store
}

// ErrSourceUnavailable is returned for absent generation-scoped dashboard
// sources; Redis's existing sentinel remains compatible with callers.
var (
	ErrSourceUnavailable    = redisx.ErrSourceUnavailable
	ErrIssueStatusAmbiguous = redisx.ErrIssueStatusAmbiguous
)

var _ Database = (*Redis)(nil)

func NewRedis(store *redisx.Store) *Redis {
	return &Redis{Store: store}
}

func (*Redis) ValidateQueries(definitions []query.Definition) error {
	return query.Validate(definitions)
}

func (db *Redis) ExecuteQueries(definitions []query.Definition, requested []string, loader query.Loader) (map[string]model.Source, model.Metrics, error) {
	if err := db.ValidateQueries(definitions); err != nil {
		return nil, model.Metrics{}, err
	}
	return query.New(loader).Execute(definitions, requested)
}
