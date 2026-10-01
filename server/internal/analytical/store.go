package analytical

import (
	"context"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type Snapshot struct {
	ID           string
	Revision     int64
	DataRevision string
	EvaluatedAt  time.Time
	ActivatedAt  time.Time
	Counts       map[string]int
}

type CanonicalStore interface {
	BeginSnapshot(context.Context, string) error
	WriteSource(context.Context, string, model.Source) error
	ValidateSnapshot(context.Context, string, map[string]int) error
	ActivateSnapshot(context.Context, string, string, time.Time, map[string]int) (Snapshot, error)
	DeleteSnapshot(context.Context, string) error
	ActiveSnapshot(context.Context) (Snapshot, error)
	PruneSnapshots(context.Context, int) (int, error)
}

type SnapshotReader interface {
	Source(context.Context, string, string) (model.Source, error)
	Sources(context.Context, string) ([]string, error)
}

type QueryExecutor interface {
	ExecutePlan(context.Context, string, []query.Definition, []string, []string, map[string]model.Source) (map[string]model.Source, model.Metrics, error)
}
