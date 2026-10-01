package redisx

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/dashboarddb"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// DashboardDatabase adapts the dashboard database boundary to Redis. The
// operational Store remains available independently for locks and caches.
type DashboardDatabase struct {
	Store             *Store
	RetainGenerations int
}

var _ dashboarddb.Database = (*DashboardDatabase)(nil)

func (db *DashboardDatabase) Current(ctx context.Context) (dashboarddb.Reader, error) {
	active, err := db.Store.Active(ctx)
	if err != nil {
		return nil, err
	}
	evaluatedAt := active.EvaluatedAt
	if evaluatedAt.IsZero() {
		evaluatedAt = active.Activated
	}
	return &redisDashboardReader{store: db.Store, generation: active.Generation, state: dashboarddb.State{
		Revision: active.Revision, DataRevision: active.DataRevision,
		EvaluatedAt: evaluatedAt, Counts: active.Counts, Available: active.Generation != "",
	}}, nil
}

func (db *DashboardDatabase) Ingest(ctx context.Context, transactions dashboarddb.Transactions) (dashboarddb.State, error) {
	if len(transactions.DataRevision) < 12 {
		return dashboarddb.State{}, errors.New("dashboard data revision is invalid")
	}
	generation := time.Now().UTC().Format("20060102T150405.000000000Z") + "-" + transactions.DataRevision[len(transactions.DataRevision)-12:]
	if err := db.Store.TrackGeneration(ctx, generation); err != nil {
		return dashboarddb.State{}, err
	}

	activationStarted := false
	defer func() {
		if activationStarted {
			return
		}

		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := db.Store.DiscardGeneration(cleanup, generation); err != nil {
			redisLog.Printf("failed generation cleanup incomplete")
		}
	}()
	counts := make(map[string]int, len(transactions.Sources))
	for _, name := range sortedDashboardSources(transactions.Sources) {
		source := transactions.Sources[name]
		if err := db.Store.PutSource(ctx, generation, source); err != nil {
			return dashboarddb.State{}, fmt.Errorf("stage dashboard source: %w", err)
		}
		counts[name] = len(source.Rows)
	}
	if err := db.Store.PutDiagnostics(ctx, generation, transactions.Diagnostics); err != nil {
		return dashboarddb.State{}, fmt.Errorf("stage diagnostics: %w", err)
	}
	if err := db.Store.PutRepositoryMemory(ctx, generation, transactions.RepositoryMemory, transactions.MemoryFiles); err != nil {
		return dashboarddb.State{}, fmt.Errorf("stage repository memory: %w", err)
	}
	if err := db.Store.TrackGeneration(ctx, generation); err != nil {
		return dashboarddb.State{}, err
	}
	activationStarted = true
	revision, err := db.Store.Activate(ctx, generation, transactions.DataRevision, transactions.EvaluatedAt, counts)
	if err != nil {
		return dashboarddb.State{}, err
	}
	if _, err := db.Store.PruneGenerations(ctx, db.RetainGenerations); err != nil {
		redisLog.Printf("generation reclamation failed")
	}
	return dashboarddb.State{
		Revision: revision, DataRevision: transactions.DataRevision,
		EvaluatedAt: transactions.EvaluatedAt, Counts: counts, Available: true,
	}, nil
}

func (db *DashboardDatabase) Validate(ctx context.Context, definitions []query.Definition) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return query.Validate(definitions)
}

func (db *DashboardDatabase) ApplyIssueStatus(ctx context.Context, update dashboarddb.IssueStatusUpdate, ttl time.Duration) (dashboarddb.IssueStatusResult, error) {
	applied, duplicate, revision, err := db.Store.ApplyIssueUpdate(ctx, update, ttl)
	return dashboarddb.IssueStatusResult{
		Applied: applied, Duplicate: duplicate, Revision: revision,
	}, err
}

func sortedDashboardSources(sources map[string]model.Source) []string {
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type redisDashboardReader struct {
	store      *Store
	generation string
	state      dashboarddb.State
}

func (reader *redisDashboardReader) State() dashboarddb.State { return reader.state }

func (reader *redisDashboardReader) Execute(ctx context.Context, definitions []query.Definition, requested []string, runtime dashboarddb.RuntimeSource) (map[string]model.Source, model.Metrics, error) {
	if !reader.state.Available {
		return nil, model.Metrics{}, ErrSourceUnavailable
	}
	return query.New(&dashboardLoader{ctx: ctx, store: reader.store, generation: reader.generation, runtime: runtime}).Execute(definitions, requested)
}

type dashboardLoader struct {
	ctx        context.Context
	store      *Store
	generation string
	runtime    dashboarddb.RuntimeSource
}

func (loader *dashboardLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	if loader.runtime != nil {
		source, metrics, handled, err := loader.runtime(name, definition)
		if handled {
			return source, metrics, err
		}
	}
	source, metrics, err := loader.store.LoadSource(loader.ctx, loader.generation, name, definition)
	if errors.Is(err, ErrSourceUnavailable) {
		return model.Source{
			Source: name, Rows: []model.Row{},
			Metadata: model.Metadata{
				"source-id": name, "availability": "unavailable",
				"completeness": "unknown", "freshness": "unknown",
			},
		}, metrics, nil
	}
	return source, metrics, err
}
