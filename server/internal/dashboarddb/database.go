// Package dashboarddb defines the persistence and query boundary for dashboard
// data. Operational state (sessions, queues, counters and caches) stays in Redis.
package dashboarddb

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

// State describes the currently published dashboard data without exposing its
// backend's storage identity.
type State struct {
	Available    bool
	Revision     int64
	DataRevision string
	EvaluatedAt  time.Time
	Activated    time.Time
	Counts       map[string]int
}

// Projection is a complete, validated replacement for dashboard data.
type Projection struct {
	DataRevision   string
	EvaluatedAt    time.Time
	Sources        map[string]model.Source
	Diagnostics    model.Diagnostics
	MemoryManifest []byte
	MemoryFiles    map[string][]byte
}

// Snapshot pins one published version for a request, including all its reads.
type Snapshot interface {
	State() State
	LoadSource(context.Context, string, *query.Definition) (model.Source, model.Metrics, error)
	Diagnostics(context.Context) (model.Diagnostics, error)
	RepositoryMemoryManifest(context.Context) ([]byte, error)
	RepositoryMemoryFile(context.Context, string, string) ([]byte, error)
}

type IssueUpdates interface {
	ApplyIssueUpdate(context.Context, model.IssueUpdate, time.Duration) (bool, bool, int64, error)
}

// Database owns atomic replacement and consistent reads of dashboard data,
// together with validation and execution of Dashboard Language queries.
type Database interface {
	Open(context.Context) (Snapshot, error)
	Replace(context.Context, Projection) (State, error)
	IssueUpdates
	ValidateQueries([]query.Definition) error
	Project(query.Definition, map[string]model.Source) (model.Source, error)
	ExecuteQueries([]query.Definition, []string, query.Loader) (map[string]model.Source, model.Metrics, error)
}

// Redis implements Database over the generation-scoped Redis projection.
// Operational Redis is supplied separately to server components.
type Redis struct {
	store     *redisx.Store
	retention int
}

var (
	ErrSourceUnavailable    = errors.New("dashboard source unavailable")
	ErrIssueStatusAmbiguous = errors.New("issue status ambiguous")
)

var _ Database = (*Redis)(nil)

func NewRedis(store *redisx.Store) *Redis {
	return &Redis{store: store}
}

func NewRedisWithRetention(store *redisx.Store, retention int) *Redis {
	return &Redis{store: store, retention: retention}
}

func state(active redisx.ActiveGeneration) State {
	return State{
		Available: active.Generation != "", Revision: active.Revision,
		DataRevision: active.DataRevision, EvaluatedAt: active.EvaluatedAt,
		Activated: active.Activated, Counts: active.Counts,
	}
}

type redisSnapshot struct {
	store      *redisx.Store
	generation string
	state      State
}

func (s *redisSnapshot) State() State { return s.state }

func (s *redisSnapshot) LoadSource(ctx context.Context, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	source, metrics, err := s.store.LoadSource(ctx, s.generation, name, definition)
	return source, metrics, databaseError(err)
}

func (s *redisSnapshot) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	return s.store.Diagnostics(ctx, s.generation)
}

func (s *redisSnapshot) RepositoryMemoryManifest(ctx context.Context) ([]byte, error) {
	content, err := s.store.RepositoryMemoryManifest(ctx, s.generation)
	return content, databaseError(err)
}

func (s *redisSnapshot) RepositoryMemoryFile(ctx context.Context, campaign, path string) ([]byte, error) {
	content, err := s.store.RepositoryMemoryFile(ctx, s.generation, campaign, path)
	return content, databaseError(err)
}

func databaseError(err error) error {
	switch {
	case errors.Is(err, redisx.ErrSourceUnavailable):
		return ErrSourceUnavailable
	case errors.Is(err, redisx.ErrIssueStatusAmbiguous):
		return ErrIssueStatusAmbiguous
	default:
		return err
	}
}

func (db *Redis) Open(ctx context.Context) (Snapshot, error) {
	active, err := db.store.Active(ctx)
	if err != nil {
		return nil, err
	}
	return &redisSnapshot{store: db.store, generation: active.Generation, state: state(active)}, nil
}

func (db *Redis) Replace(ctx context.Context, projection Projection) (State, error) {
	if len(projection.DataRevision) < 12 {
		return State{}, errors.New("dashboard data revision is required")
	}
	generation := time.Now().UTC().Format("20060102T150405.000000000Z") + "-" + projection.DataRevision[len(projection.DataRevision)-12:]
	if err := db.store.TrackGeneration(ctx, generation); err != nil {
		return State{}, err
	}
	activating := false
	defer func() {
		if activating {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = db.store.DiscardGeneration(cleanup, generation)
	}()
	counts := make(map[string]int, len(projection.Sources))
	names := make([]string, 0, len(projection.Sources))
	for name := range projection.Sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		source := projection.Sources[name]
		if err := db.store.PutSource(ctx, generation, source); err != nil {
			return State{}, err
		}
		counts[name] = len(source.Rows)
	}
	if err := db.store.PutDiagnostics(ctx, generation, projection.Diagnostics); err != nil {
		return State{}, err
	}
	if err := db.store.PutRepositoryMemory(ctx, generation, projection.MemoryManifest, projection.MemoryFiles); err != nil {
		return State{}, err
	}
	if err := db.store.TrackGeneration(ctx, generation); err != nil {
		return State{}, err
	}
	activating = true
	revision, err := db.store.Activate(ctx, generation, projection.DataRevision, projection.EvaluatedAt, counts)
	if err != nil {
		return State{}, err
	}
	// Reclamation is best-effort after publication; a failure must not undo it.
	_, _ = db.store.PruneGenerations(ctx, db.retention)
	return State{Available: true, Revision: revision, DataRevision: projection.DataRevision,
		EvaluatedAt: projection.EvaluatedAt, Counts: counts}, nil
}

func (db *Redis) ApplyIssueUpdate(ctx context.Context, update model.IssueUpdate, ttl time.Duration) (bool, bool, int64, error) {
	applied, stale, revision, err := db.store.ApplyIssueUpdate(ctx, update, ttl)
	return applied, stale, revision, databaseError(err)
}

func (*Redis) ValidateQueries(definitions []query.Definition) error {
	return query.Validate(definitions)
}

func (db *Redis) Project(definition query.Definition, sources map[string]model.Source) (model.Source, error) {
	result, _, _, err := query.ExecuteDefinition(definition, sources, query.MaxOperations)
	return result, err
}

func (db *Redis) ExecuteQueries(definitions []query.Definition, requested []string, loader query.Loader) (map[string]model.Source, model.Metrics, error) {
	if err := db.ValidateQueries(definitions); err != nil {
		return nil, model.Metrics{}, err
	}
	return query.New(loader).Execute(definitions, requested)
}
