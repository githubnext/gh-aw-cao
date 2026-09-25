package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var projectorLog = logger.New("cao:collect:projector")

const (
	projectionDirtyKey = "collect:projection-dirty"
	projectionLockName = "projection"
)

// Projector turns the evidence lake into an active canonical generation.
//
// It regenerates the payload manifest with the Activity CLI and then calls the
// Actions profile's ingestion implementation over the lake directory. There is
// no second projector, no second canonical mapping, and no incremental upsert
// path that could observe a dangling relationship.
//
// Projection is coalesced: collections that complete within one debounce
// window produce a single generation. Coalescing, not per-run projection, is
// what keeps projection cost sublinear in run volume.
type Projector struct {
	Store               *redisx.Store
	Lake                Lake
	Enrollment          Enrollment
	CatalogRoot         string
	NodeBinary          string
	DatabaseQueriesPath string
	// ControlRepository names the control repository used during inventory
	// discovery.
	ControlRepository string
	// MinInterval is the shortest gap between two projections.
	MinInterval time.Duration
	// LockTTL bounds how long a projection may hold the global lease.
	LockTTL time.Duration
	// Timeout bounds one projection.
	Timeout time.Duration
	// RetainGenerations bounds superseded generations kept for rollback.
	RetainGenerations int
	// InventoryRepositoryLimit bounds how many enrolled repositories are named
	// during inventory discovery. Zero means unbounded: truncating the
	// inventory would silently drop enrolled repositories from the dashboard
	// while reporting success.
	InventoryRepositoryLimit int
}

// defaultProjectionInterval is the shortest gap between two projections.
//
// A projection rehashes the whole evidence lake before it can decide whether
// anything changed, so its cost scales with retained evidence rather than with
// the collection that triggered it. Five minutes keeps the dashboard current
// without making that whole-lake scan the dominant steady-state cost.
const defaultProjectionInterval = 5 * time.Minute

func (p Projector) minInterval() time.Duration {
	if p.MinInterval <= 0 {
		return defaultProjectionInterval
	}
	return p.MinInterval
}

func (p Projector) lockTTL() time.Duration {
	if p.LockTTL <= 0 {
		return 30 * time.Minute
	}
	return p.LockTTL
}

func (p Projector) timeout() time.Duration {
	if p.Timeout <= 0 {
		return 25 * time.Minute
	}
	return p.Timeout
}

func (p Projector) node() string {
	if p.NodeBinary != "" {
		return p.NodeBinary
	}
	return "node"
}

// RequestProjection marks the lake as changed. Marking is idempotent, so a
// burst of collections requests one projection.
func (p Projector) RequestProjection(ctx context.Context) error {
	return p.Store.SetOperationalState(ctx, projectionDirtyKey,
		[]byte(time.Now().UTC().Format(time.RFC3339Nano)))
}

// PendingProjection reports whether the lake changed since the last
// projection.
func (p Projector) PendingProjection(ctx context.Context) (bool, error) {
	value, err := p.Store.OperationalState(ctx, projectionDirtyKey)
	return len(value) > 0, err
}

// ErrProjectionBusy reports that another process holds the projection lease.
var ErrProjectionBusy = errors.New("a projection update is already running")

// Project regenerates the manifest and activates a new generation. A failed
// projection leaves the previously active generation serving.
func (p Projector) Project(ctx context.Context) (ingest.Result, error) {
	return p.project(ctx, false)
}

// Rebuild reprojects unconditionally. An operator rebuilding is repairing the
// canonical database, so an unchanged lake must still be reprojected rather
// than short-circuited.
func (p Projector) Rebuild(ctx context.Context) (ingest.Result, error) {
	return p.project(ctx, true)
}

func (p Projector) project(ctx context.Context, force bool) (ingest.Result, error) {
	if p.DatabaseQueriesPath == "" {
		return ingest.Result{}, errors.New("database query path is required")
	}
	token, err := operationToken()
	if err != nil {
		return ingest.Result{}, err
	}
	acquired, err := p.Store.TryLock(ctx, projectionLockName, token, p.lockTTL())
	if err != nil {
		return ingest.Result{}, err
	}
	if !acquired {
		return ingest.Result{}, ErrProjectionBusy
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = p.Store.Unlock(release, projectionLockName, token)
	}()
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	if err := p.Store.SetOperationalState(ctx, projectionDirtyKey, nil); err != nil {
		return ingest.Result{}, err
	}
	if err := p.refreshCompaction(ctx); err != nil {
		return ingest.Result{}, err
	}
	// Force is deliberately not set. A collection re-enumerates a repository's
	// window and usually adds nothing, so most projections would otherwise
	// rewrite an identical canonical dataset. The content-addressed data
	// revision skips those, which is what keeps a 60-second projection
	// interval affordable.
	result, err := ingest.Run(ctx, p.Store, p.Lake.Directory, ingest.Options{
		DatabaseQueriesPath: p.DatabaseQueriesPath,
		RetainGenerations:   p.RetainGenerations,
		Force:               force,
	})
	if err != nil {
		// The lake is unchanged and the previous generation keeps serving, so
		// the change marker is restored for the next attempt.
		_ = p.RequestProjection(context.WithoutCancel(ctx))
		return ingest.Result{}, err
	}
	projectorLog.Printf("activated generation revision=%d sources=%d", result.Revision, len(result.Counts))
	return result, nil
}

// refreshCompaction recompacts collected shards into the run and record
// phases and regenerates the manifest.
//
// Without a catalog root the projector replays an already-compacted lake as
// it stands. That is the recovery path: a lake published or compacted earlier
// is projectable on its own, and a lake that is not already compacted fails
// closed rather than being projected half-formed.
func (p Projector) refreshCompaction(ctx context.Context) error {
	if p.CatalogRoot == "" {
		populated, err := p.Lake.Populated()
		if err != nil {
			return err
		}
		if !populated {
			return errors.New(
				"replay requires an already-compacted evidence lake with a manifest")
		}
		projectorLog.Printf("replaying a compacted evidence lake without recompaction")
		return nil
	}
	if err := p.refreshInventory(ctx); err != nil {
		// Inventory is an auxiliary logical source. A failure degrades
		// completeness; it must not discard collected evidence.
		projectorLog.Printf("inventory discovery failed; continuing with the previous inventory")
	}
	return p.refreshManifest(ctx)
}

// refreshManifest regenerates payload-hashes.json, gh-aw-logs-runs, and
// gh-aw-logs-records with the same Activity CLI command the Actions profile
// uses.
func (p Projector) refreshManifest(ctx context.Context) error {
	arguments := []string{
		filepath.Join(p.CatalogRoot, "activity", "cao.mjs"),
		"hash-payloads",
		"--shard-dir", p.Lake.ShardDirectory(),
		"--runs-dir", p.Lake.RunsDirectory(),
		"--records-dir", p.Lake.RecordsDirectory(),
		"--inventory", p.Lake.InventoryPath(),
		"--output", p.Lake.ManifestPath(),
	}
	return p.run(ctx, arguments)
}

// refreshInventory rebuilds the logical source inventory from the enrollment
// set, using the Activity CLI's discovery command.
func (p Projector) refreshInventory(ctx context.Context) error {
	if p.ControlRepository == "" {
		return errors.New("control repository is required for inventory discovery")
	}
	repositories, err := p.enrolledRepositories(ctx)
	if err != nil {
		return err
	}
	settings, err := json.MarshalIndent(map[string]any{
		"allowed_repositories": repositories,
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := WriteFileAtomic(p.Lake.ControlSettingsPath(), append(settings, '\n')); err != nil {
		return err
	}
	arguments := []string{
		filepath.Join(p.CatalogRoot, "activity", "cao.mjs"),
		"discover-workflows",
		"--control-settings", p.Lake.ControlSettingsPath(),
		"--inventory", filepath.Join(p.Lake.Directory, "control-plane-inventory.json"),
		"--output", p.Lake.InventoryPath(),
		"--repo", p.ControlRepository,
	}
	return p.run(ctx, arguments)
}

// enrolledRepositories names every enrolled repository.
//
// The enumeration is deliberately unbounded by default. Truncating it would
// silently omit enrolled repositories from the inventory, and therefore from
// the dashboard, while still reporting a successful projection. An operator who
// needs a bound sets InventoryRepositoryLimit, and exceeding it fails the
// projection rather than publishing a partial inventory.
func (p Projector) enrolledRepositories(ctx context.Context) ([]string, error) {
	var repositories []string
	cursor := ""
	for {
		page, next, err := p.Enrollment.ScanRepositories(ctx, cursor, 500)
		if err != nil {
			return nil, err
		}
		repositories = append(repositories, page...)
		if p.InventoryRepositoryLimit > 0 && len(repositories) > p.InventoryRepositoryLimit {
			return nil, fmt.Errorf(
				"enrolled repositories exceed the configured inventory limit of %d",
				p.InventoryRepositoryLimit,
			)
		}
		if next == "0" || next == "" {
			break
		}
		cursor = next
	}
	sort.Strings(repositories)
	return repositories, nil
}

func (p Projector) run(ctx context.Context, arguments []string) error {
	// #nosec G204 -- arguments are built from validated configuration paths.
	command := exec.CommandContext(ctx, p.node(), arguments...)
	command.Dir = p.CatalogRoot
	command.Env = collectionEnvironment()
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("activity CLI failed: %w: %s", err, summarize(string(output)))
	}
	return nil
}
