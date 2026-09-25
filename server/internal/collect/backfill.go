package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var backfillLog = logger.New("cao:collect:backfill")

const backfillStateKey = "collect:backfill"

// Enumerator is the App-level enumeration the cold start needs. It is an
// interface so tests substitute a fake GitHub API.
type Enumerator interface {
	ListInstallations(ctx context.Context) ([]githubapp.Installation, error)
	ListRepositories(ctx context.Context, installationID int64) ([]githubapp.Repository, error)
}

// Backfill performs resumable cold start.
//
// It replays the evidence lake first, because a populated lake repopulates an
// empty canonical database with zero GitHub requests. Enumeration is used only
// when enrollment must be discovered or repaired.
type Backfill struct {
	Store      *redisx.Store
	Enrollment Enrollment
	Queue      Queue
	Projector  Projector
	Lake       Lake
	Enumerator Enumerator
}

// BackfillState is the resumable checkpoint, published for status reporting.
type BackfillState struct {
	Phase              string `json:"phase"`
	StartedAt          string `json:"startedAt,omitempty"`
	CompletedAt        string `json:"completedAt,omitempty"`
	Installations      int    `json:"installations"`
	Repositories       int    `json:"repositories"`
	QueuedRepositories int    `json:"queuedRepositories"`
	LakeReplayed       bool   `json:"lakeReplayed"`
	Revision           int64  `json:"revision,omitempty"`
	Error              string `json:"error,omitempty"`
}

// Run performs cold start: replay, enumerate, seed, and let workers collect.
func (b Backfill) Run(ctx context.Context) (BackfillState, error) {
	state := BackfillState{Phase: "replaying", StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	b.publish(ctx, state)
	populated, err := b.Lake.Populated()
	if err != nil {
		return b.fail(ctx, state, err)
	}
	if populated {
		result, err := b.replay(ctx)
		if err != nil {
			return b.fail(ctx, state, err)
		}
		state.LakeReplayed = true
		state.Revision = result.Revision
		backfillLog.Printf("replayed evidence lake revision=%d", result.Revision)
	}
	state.Phase = "enumerating"
	b.publish(ctx, state)
	repositories, installations, err := b.enumerate(ctx)
	if err != nil {
		return b.fail(ctx, state, err)
	}
	state.Installations = installations
	state.Repositories = len(repositories)
	state.Phase = "seeding"
	b.publish(ctx, state)
	queued, err := b.seed(ctx, repositories)
	if err != nil {
		return b.fail(ctx, state, err)
	}
	state.QueuedRepositories = queued
	state.Phase = "collecting"
	state.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	b.publish(ctx, state)
	backfillLog.Printf("cold start seeded repositories=%d queued=%d", len(repositories), queued)
	return state, nil
}

// Replay repopulates from the evidence lake alone. It issues no GitHub
// requests and is the normal recovery path.
func (b Backfill) Replay(ctx context.Context) (ingest.Result, error) {
	populated, err := b.Lake.Populated()
	if err != nil {
		return ingest.Result{}, err
	}
	if !populated {
		return ingest.Result{}, errors.New("evidence lake holds no collected shards")
	}
	return b.replay(ctx)
}

func (b Backfill) replay(ctx context.Context) (ingest.Result, error) {
	return b.Projector.Project(ctx)
}

type enrolledRepository struct {
	name     string
	pushedAt time.Time
}

func (b Backfill) enumerate(ctx context.Context) ([]enrolledRepository, int, error) {
	if b.Enumerator == nil {
		return nil, 0, errors.New("cold start requires GitHub App enumeration")
	}
	installations, err := b.Enumerator.ListInstallations(ctx)
	if err != nil {
		return nil, 0, err
	}
	var repositories []enrolledRepository
	for _, installation := range installations {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		covered, err := b.Enumerator.ListRepositories(ctx, installation.ID)
		if err != nil {
			// One installation that cannot be read must not abort cold start
			// for the rest; the gap is visible in enrollment coverage.
			backfillLog.Printf("installation enumeration failed; continuing installation=%d", installation.ID)
			continue
		}
		names := make([]string, 0, len(covered))
		for _, repository := range covered {
			normalized, err := NormalizeRepository(repository.FullName)
			if err != nil {
				continue
			}
			names = append(names, normalized)
			repositories = append(repositories, enrolledRepository{
				name: normalized, pushedAt: repository.PushedAt,
			})
		}
		if err := b.Enrollment.AddRepositories(ctx, installation.ID, names); err != nil {
			return nil, 0, err
		}
	}
	return repositories, len(installations), nil
}

// seed queues backfill tasks ordered by recency so active repositories become
// queryable first.
func (b Backfill) seed(ctx context.Context, repositories []enrolledRepository) (int, error) {
	sort.Slice(repositories, func(first, second int) bool {
		return repositories[first].pushedAt.After(repositories[second].pushedAt)
	})
	if err := b.Queue.Ensure(ctx); err != nil {
		return 0, err
	}
	queued := 0
	for _, repository := range repositories {
		if ctx.Err() != nil {
			return queued, ctx.Err()
		}
		installationID, err := b.Enrollment.InstallationFor(ctx, repository.name)
		if err != nil || installationID == 0 {
			continue
		}
		enqueued, err := b.Queue.Enqueue(ctx, Task{
			Repository:     repository.name,
			InstallationID: installationID,
			Reason:         "backfill",
		})
		if err != nil {
			return queued, err
		}
		if enqueued {
			queued++
		}
	}
	return queued, nil
}

func (b Backfill) fail(ctx context.Context, state BackfillState, cause error) (BackfillState, error) {
	state.Phase = "failed"
	state.Error = cause.Error()
	state.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	b.publish(ctx, state)
	return state, cause
}

func (b Backfill) publish(ctx context.Context, state BackfillState) {
	payload, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = b.Store.SetOperationalState(ctx, backfillStateKey, payload)
}

// State reads the last published cold-start checkpoint.
func (b Backfill) State(ctx context.Context) (BackfillState, error) {
	payload, err := b.Store.OperationalState(ctx, backfillStateKey)
	if err != nil || len(payload) == 0 {
		return BackfillState{Phase: "idle"}, err
	}
	var state BackfillState
	if err := json.Unmarshal(payload, &state); err != nil {
		return BackfillState{Phase: "idle"}, fmt.Errorf("decode backfill state: %w", err)
	}
	return state, nil
}
