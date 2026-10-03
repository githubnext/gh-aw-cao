package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/operationalvalue"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var projectorLog = logger.New("cao:collect:projector")

const (
	projectionDirtyKey = "collect:projection-dirty"
	projectionLockName = "projection"
)

// Projector turns the evidence lake into the current canonical dashboard data.
//
// It regenerates the payload manifest with the Activity CLI and then calls the
// Actions profile's ingestion implementation over the lake directory. There is
// no second projector, no second canonical mapping, and no incremental upsert
// path that could observe a dangling relationship.
//
// Projection is coalesced: collections that complete within one debounce
// window produce a single replacement. Coalescing, not per-run projection, is
// what keeps projection cost sublinear in run volume.
type Projector struct {
	Store               *redisx.Store
	Data                *postgresx.Store
	Lake                Lake
	Enrollment          Enrollment
	CatalogRoot         string
	NodeBinary          string
	GitHubBinary        string
	GitHubAPIURL        string
	Tokens              TokenProvider
	Budget              *githubapp.Budget
	WindowDays          int
	DatabaseQueriesPath string
	// PolicyPath is the reviewed deployment policy resolved for inventory.
	PolicyPath string
	// StaticInventoryPath is the source-bound control-plane inventory packaged
	// with the collector image.
	StaticInventoryPath string
	// ControlRepository names the control repository used during inventory
	// discovery.
	ControlRepository string
	// MinInterval is the shortest gap between two projections.
	MinInterval time.Duration
	// LockTTL bounds how long a projection may hold the global lease.
	LockTTL time.Duration
	// Timeout bounds one projection.
	Timeout time.Duration
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

func (p Projector) windowDays() int {
	if p.WindowDays <= 0 {
		return 30
	}
	return p.WindowDays
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

// Project regenerates the manifest and replaces the canonical data. A failed
// projection leaves the previously active data serving.
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
	if p.Data == nil {
		return ingest.Result{}, errors.New("projection requires Postgres")
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
		_ = p.RequestProjection(context.WithoutCancel(ctx))
		return ingest.Result{}, err
	}
	// Force is deliberately not set. A collection re-enumerates a repository's
	// window and usually adds nothing, so most projections would otherwise
	// rewrite an identical canonical dataset. The content-addressed data
	// revision skips those, which is what keeps a 60-second projection
	// interval affordable.
	result, err := ingest.Run(ctx, p.Data, p.Lake.Directory, ingest.Options{
		DatabaseQueriesPath: p.DatabaseQueriesPath,
		Force:               force,
	})
	if err != nil {
		// The lake is unchanged and the previous data keeps serving, so
		// the change marker is restored for the next attempt.
		_ = p.RequestProjection(context.WithoutCancel(ctx))
		return ingest.Result{}, err
	}
	projectorLog.Printf("activated dashboard data revision=%d sources=%d", result.Revision, len(result.Counts))
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
		if previousErr := p.validateExistingInventory(); previousErr != nil {
			return fmt.Errorf(
				"inventory discovery failed and no previous valid inventory is available: %w",
				errors.Join(err, previousErr),
			)
		}
		projectorLog.Printf("inventory discovery failed; retaining the previous valid inventory")
	}
	if err := p.refreshManifest(ctx); err != nil {
		return err
	}
	if p.Tokens != nil {
		if err := p.refreshOperationalValues(ctx); err != nil {
			// Match the Actions profile: operational value is best-effort and
			// must not prevent newer Activity evidence from being projected.
			projectorLog.Printf("operational value reconstruction failed; continuing without refreshed values")
		}
		return p.refreshManifest(ctx)
	}
	return nil
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

// refreshOperationalValues reconstructs the same retained operational-value
// history as the Actions profile, using a short-lived Activity projection and
// one installation-scoped token per enrolled repository.
func (p Projector) refreshOperationalValues(ctx context.Context) error {
	repositories, err := p.enrolledRepositories(ctx)
	if err != nil {
		return err
	}
	if len(repositories) == 0 {
		return nil
	}
	workspace, err := os.MkdirTemp("", "cao-operational-value-")
	if err != nil {
		return fmt.Errorf("create operational value workspace: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(workspace)
	}()
	database := filepath.Join(workspace, "activity.sqlite")
	retentionDays := strconv.Itoa(p.windowDays())
	if err := p.run(ctx, []string{
		filepath.Join(p.CatalogRoot, "activity", "cao.mjs"),
		"ingest-jsonl",
		"--database", database,
		"--runs-dir", p.Lake.RunsDirectory(),
		"--records-dir", p.Lake.RecordsDirectory(),
		"--retention-days", retentionDays,
		"--run-retention-days", retentionDays,
	}); err != nil {
		return err
	}
	observedAt := time.Now().UTC()
	output := filepath.Join(p.Lake.ShardDirectory(), "operational-values.jsonl")
	history := false
	if _, err := os.Stat(filepath.Join(p.CatalogRoot, "optimization", "operational-value.mjs")); err == nil {
		history = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, repository := range repositories {
		installationID, err := p.Enrollment.InstallationFor(ctx, repository)
		if err != nil {
			return fmt.Errorf("resolve installation for %s: %w", repository, err)
		}
		if installationID <= 0 {
			return fmt.Errorf("resolve installation for %s: no installation is enrolled", repository)
		}
		reserve, err := p.rateLimitReserve(ctx, installationID)
		if err != nil {
			return err
		}
		token, err := p.Tokens.InstallationToken(ctx, installationID)
		if err != nil {
			return err
		}
		environment := append(collectionEnvironment(p.GitHubAPIURL), []string{
			"CAO_OPERATIONAL_VALUE_GH_TOKEN=" + token,
			"GH_TOKEN=" + token,
			"CAO_GITHUB_API_MIN_REMAINING=" + strconv.Itoa(reserve),
		}...)
		historyCampaign := ""
		if history {
			historyCampaign = "optimization"
		}
		result, err := operationalvalue.Collect(ctx, operationalvalue.Config{
			Root: p.CatalogRoot, Database: database, Output: output,
			ObservedAt: observedAt, Repositories: []string{repository},
			HistoryCampaign: historyCampaign,
			Retention:       time.Duration(p.windowDays()) * 24 * time.Hour,
			NodeBinary:      p.node(), GitHubBinary: p.GitHubBinary,
			Environment: environment, RedactValues: []string{token},
			RateLimitReserve: reserve,
		})
		if err != nil {
			return err
		}
		if len(result.Warnings) > 0 {
			projectorLog.Printf("operational value adapters failed count=%d", len(result.Warnings))
		}
	}
	return nil
}

func (p Projector) rateLimitReserve(ctx context.Context, installationID int64) (int, error) {
	if p.Budget == nil {
		return 2000, nil
	}
	reserve, err := p.Budget.Reserve(ctx, installationID)
	if !errors.Is(err, githubapp.ErrBudgetUnknown) {
		return reserve, err
	}
	provider, ok := p.Tokens.(rateLimitProvider)
	if !ok {
		return 0, errors.New("rate-limit budget is unknown and cannot be refreshed")
	}
	remaining, reset, err := provider.RateLimit(ctx, installationID)
	if err != nil {
		return 0, err
	}
	if err := p.Budget.Observe(ctx, installationID, remaining, reset); err != nil {
		return 0, err
	}
	return p.Budget.Reserve(ctx, installationID)
}

// refreshInventory rebuilds the logical source inventory from the enrollment
// set, using the Activity CLI's discovery command.
func (p Projector) refreshInventory(ctx context.Context) error {
	if p.ControlRepository == "" {
		return errors.New("control repository is required for inventory discovery")
	}
	if p.PolicyPath == "" {
		return errors.New("control policy path is required for inventory discovery")
	}
	if p.StaticInventoryPath == "" {
		return errors.New("static control-plane inventory path is required for inventory discovery")
	}
	if p.Tokens == nil {
		return errors.New("installation token provider is required for inventory discovery")
	}
	repositories, err := p.enrolledRepositories(ctx)
	if err != nil {
		return err
	}
	workspace, err := os.MkdirTemp(p.Lake.Directory, ".inventory-refresh-")
	if err != nil {
		return fmt.Errorf("create inventory refresh workspace: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(workspace)
	}()
	settingsPath := filepath.Join(workspace, "control-settings.json")
	inventoryPath := filepath.Join(workspace, "control-plane-inventory.json")
	sourcesPath := filepath.Join(workspace, "inventory-sources.json")
	controlProgram := filepath.Join(p.CatalogRoot, ".github", "workflows", "shared", "control.mjs")
	if err := p.runWithEnvironment(ctx, []string{
		filepath.Join(p.CatalogRoot, "activity", "control-settings.mjs"),
		controlProgram,
		p.PolicyPath,
		settingsPath,
	}, []string{"GITHUB_REPOSITORY=" + p.ControlRepository}); err != nil {
		return fmt.Errorf("resolve control settings: %w", err)
	}
	settings, err := overlayInventoryRepositories(settingsPath, repositories)
	if err != nil {
		return err
	}
	if err := validateControlSettings(settings); err != nil {
		return err
	}
	if err := WriteFileAtomic(settingsPath, settings); err != nil {
		return err
	}
	installationID, err := p.Enrollment.InstallationFor(ctx, p.ControlRepository)
	if err != nil {
		return fmt.Errorf("resolve control repository installation: %w", err)
	}
	if installationID <= 0 {
		return errors.New("control repository is not covered by an enrolled GitHub App installation")
	}
	reserve, err := p.rateLimitReserve(ctx, installationID)
	if err != nil {
		return err
	}
	token, err := p.Tokens.InstallationToken(ctx, installationID)
	if err != nil {
		return fmt.Errorf("mint control repository installation token: %w", err)
	}
	arguments := []string{
		filepath.Join(p.CatalogRoot, "activity", "cao.mjs"),
		"discover-workflows",
		"--source-inventory", p.StaticInventoryPath,
		"--control-settings", settingsPath,
		"--inventory", inventoryPath,
		"--output", sourcesPath,
		"--repo", p.ControlRepository,
	}
	environment := []string{
		"GITHUB_REPOSITORY=" + p.ControlRepository,
		"GH_TOKEN=" + token,
		"GITHUB_TOKEN=" + token,
		"CAO_GITHUB_TOKEN_TYPE=github-app-installation",
		"CAO_GITHUB_CREDENTIAL_ID=" + strconv.FormatInt(installationID, 10),
		"CAO_GITHUB_CREDENTIAL_ROLE=read",
		"CAO_GITHUB_API_MIN_REMAINING=" + strconv.Itoa(reserve),
	}
	if err := p.runWithEnvironment(ctx, arguments, environment, token); err != nil {
		return err
	}
	// #nosec G304 -- sourcesPath is constructed inside the projector-owned workspace.
	sources, err := os.ReadFile(sourcesPath)
	if err != nil {
		return fmt.Errorf("read refreshed inventory sources: %w", err)
	}
	if err := validateInventorySources(sources); err != nil {
		return err
	}
	// #nosec G304 -- inventoryPath is constructed inside the projector-owned workspace.
	inventory, err := os.ReadFile(inventoryPath)
	if err != nil {
		return fmt.Errorf("read refreshed control-plane inventory: %w", err)
	}
	if err := validateControlPlaneInventory(inventory); err != nil {
		return err
	}
	if err := WriteFileAtomic(p.Lake.ControlSettingsPath(), settings); err != nil {
		return err
	}
	if err := WriteFileAtomic(p.Lake.ControlPlaneInventoryPath(), inventory); err != nil {
		return err
	}
	if err := WriteFileAtomic(p.Lake.InventoryPath(), sources); err != nil {
		return err
	}
	return nil
}

func overlayInventoryRepositories(path string, repositories []string) ([]byte, error) {
	// #nosec G304 -- callers pass the projector-owned staged control-settings path.
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read resolved control settings: %w", err)
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(content, &settings); err != nil {
		return nil, fmt.Errorf("parse resolved control settings: %w", err)
	}
	var resolution struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(settings["policy_resolution"], &resolution); err != nil {
		return nil, fmt.Errorf("parse control policy resolution: %w", err)
	}
	if resolution.Status != "available" {
		return nil, fmt.Errorf("control policy resolution is unavailable: %s", resolution.Reason)
	}
	encodedRepositories, err := json.Marshal(repositories)
	if err != nil {
		return nil, err
	}
	settings["allowed_repositories"] = encodedRepositories
	result, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(result, '\n'), nil
}

func (p Projector) validateExistingInventory() error {
	settings, err := os.ReadFile(p.Lake.ControlSettingsPath())
	if err != nil {
		return fmt.Errorf("read previous control settings: %w", err)
	}
	if err := validateControlSettings(settings); err != nil {
		return err
	}
	inventory, err := os.ReadFile(p.Lake.ControlPlaneInventoryPath())
	if err != nil {
		return fmt.Errorf("read previous control-plane inventory: %w", err)
	}
	if err := validateControlPlaneInventory(inventory); err != nil {
		return err
	}
	sources, err := os.ReadFile(p.Lake.InventoryPath())
	if err != nil {
		return fmt.Errorf("read previous inventory sources: %w", err)
	}
	return validateInventorySources(sources)
}

func validateControlSettings(content []byte) error {
	var settings struct {
		Campaigns        map[string]json.RawMessage `json:"campaigns"`
		PolicyResolution struct {
			Status string `json:"status"`
		} `json:"policy_resolution"`
	}
	if err := json.Unmarshal(content, &settings); err != nil {
		return fmt.Errorf("parse control settings: %w", err)
	}
	if settings.PolicyResolution.Status != "available" {
		return errors.New("control settings do not contain an available policy resolution")
	}
	if len(settings.Campaigns) == 0 {
		return errors.New("control settings contain no campaigns")
	}
	return nil
}

func validateControlPlaneInventory(content []byte) error {
	var inventory struct {
		Campaigns []json.RawMessage `json:"campaigns"`
		Workflows []json.RawMessage `json:"workflows"`
	}
	if err := json.Unmarshal(content, &inventory); err != nil {
		return fmt.Errorf("parse control-plane inventory: %w", err)
	}
	if len(inventory.Campaigns) == 0 {
		return errors.New("control-plane inventory contains no campaigns")
	}
	if len(inventory.Workflows) == 0 {
		return errors.New("control-plane inventory contains no workflows")
	}
	return nil
}

func validateInventorySources(content []byte) error {
	var sources map[string]struct {
		Rows []json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(content, &sources); err != nil {
		return fmt.Errorf("parse inventory sources: %w", err)
	}
	for _, name := range []string{"campaigns", "repositories", "workflows", "configuration-policy"} {
		if _, ok := sources[name]; !ok {
			return fmt.Errorf("inventory sources do not contain %s", name)
		}
	}
	if len(sources["campaigns"].Rows) == 0 {
		return errors.New("inventory sources contain no campaigns")
	}
	return nil
}

// scanRepositoriesPage matches Enrollment.ScanRepositories's signature so
// collectEnrolledRepositories's pagination loop is testable against a plain
// function standing in for the real Redis-backed scan, without a fake
// Enrollment or a running Redis.
type scanRepositoriesPage func(ctx context.Context, cursor string, count int) ([]string, string, error)

// enrolledRepositoriesPageSize is how many repositories enrolledRepositories
// requests per scan cursor. It is a named constant, rather than an inline
// literal, so collectEnrolledRepositories's tests can assert the page size
// callers actually receive.
const enrolledRepositoriesPageSize = 500

// enrolledRepositories names every enrolled repository.
//
// The enumeration is deliberately unbounded by default. Truncating it would
// silently omit enrolled repositories from the inventory, and therefore from
// the dashboard, while still reporting a successful projection. An operator who
// needs a bound sets InventoryRepositoryLimit, and exceeding it fails the
// projection rather than publishing a partial inventory.
func (p Projector) enrolledRepositories(ctx context.Context) ([]string, error) {
	return collectEnrolledRepositories(ctx, p.InventoryRepositoryLimit, p.Enrollment.ScanRepositories)
}

// collectEnrolledRepositories drains scanPage cursor-by-cursor into a single
// sorted, de-duplication-free repository list, failing once the running
// total exceeds limit (a non-positive limit means unbounded). It is a pure
// loop over an injected page function so the pagination and limit-enforcement
// behavior is unit-testable without a live Redis-backed Enrollment.
func collectEnrolledRepositories(ctx context.Context, limit int, scanPage scanRepositoriesPage) ([]string, error) {
	var repositories []string
	cursor := ""
	pages := 0
	for {
		page, next, err := scanPage(ctx, cursor, enrolledRepositoriesPageSize)
		if err != nil {
			return nil, err
		}
		pages++
		repositories = append(repositories, page...)
		if limit > 0 && len(repositories) > limit {
			return nil, fmt.Errorf(
				"enrolled repositories exceed the configured inventory limit of %d",
				limit,
			)
		}
		if next == "0" || next == "" {
			break
		}
		cursor = next
	}
	sort.Strings(repositories)
	projectorLog.Printf("scanned enrolled repositories pages=%d count=%d", pages, len(repositories))
	return repositories, nil
}

func (p Projector) run(ctx context.Context, arguments []string) error {
	return p.runWithEnvironment(ctx, arguments, nil)
}

func (p Projector) runWithEnvironment(
	ctx context.Context, arguments, environment []string, redactValues ...string,
) error {
	// #nosec G204 -- arguments are built from validated configuration paths.
	command := exec.CommandContext(ctx, p.node(), arguments...)
	command.Dir = p.CatalogRoot
	command.Env = append(collectionEnvironment(p.GitHubAPIURL), environment...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := string(output)
		for _, value := range redactValues {
			if value != "" {
				message = strings.ReplaceAll(message, value, "[REDACTED]")
			}
		}
		return fmt.Errorf("activity CLI failed: %w: %s", err, summarize(message))
	}
	return nil
}
