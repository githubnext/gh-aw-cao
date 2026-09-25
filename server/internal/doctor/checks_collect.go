package doctor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

const areaCollect = "collect"

// checkCollectionProfile reports which acquisition profile the environment
// selects, and fails when it selects both.
//
// The two profiles are alternatives, never layers. A process configured for
// both would collect from GitHub and ingest published snapshots into the same
// namespace, so each would overwrite the other's generation.
func (d Doctor) checkCollectionProfile(context.Context) Check {
	const id, title = "collect.profile", "Acquisition profile"
	profile := d.profile()
	details := []Detail{
		detail("profile", profile.label),
		detail("collectAppId", presence(d.getenv("CAO_COLLECT_APP_ID"))),
		detail("sourceDirectory", presence(d.getenv("CAO_SOURCE_DIRECTORY"))),
		detail("admitOnly", fmt.Sprint(profile.admitOnly)),
	}
	if profile.conflict {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "both collection and published-snapshot ingestion are configured",
			Details: details,
			Remedy:  "the profiles are alternatives; unset CAO_SOURCE_DIRECTORY to collect, or unset CAO_COLLECT_APP_ID to ingest snapshots",
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: "this process runs the " + profile.label + " profile",
		Details: details,
	}
}

// checkCollectionSettings validates the collection environment against the
// real CollectorConfig rules.
//
// It never reads key material: a configured private key is represented by a
// placeholder, because Validate only asks whether one is present. That keeps
// the diagnostic from pulling a secret into a process that has no use for it.
func (d Doctor) checkCollectionSettings(context.Context) Check {
	const id, title = "collect.settings", "Collection settings"
	profile := d.profile()
	if !profile.collecting {
		return skipped(id, areaCollect, title, "collection is not configured; this server runs the Actions profile")
	}
	appID, appIDErr := strconv.ParseInt(d.getenv("CAO_COLLECT_APP_ID"), 10, 64)
	if appIDErr != nil || appID <= 0 {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "CAO_COLLECT_APP_ID is not a positive GitHub App identifier",
			Remedy:  "set CAO_COLLECT_APP_ID to the numeric App identifier",
		}
	}
	keySource, keyPresent, keyErr := d.privateKeySource()
	details := []Detail{
		detail("appId", fmt.Sprint(appID)),
		detail("admitOnly", fmt.Sprint(profile.admitOnly)),
		detail("privateKey", keySource),
		detail("webhookSecret", presence(d.getenv("CAO_GITHUB_WEBHOOK_SECRET"))),
		detail("lakeDirectory", presence(d.getenv("CAO_COLLECT_LAKE_DIRECTORY"))),
		detail("catalogRoot", presence(d.getenv("CAO_COLLECT_CATALOG_ROOT"))),
		detail("controlRepository", presence(d.getenv("CAO_COLLECT_CONTROL_REPOSITORY"))),
		detail("workers", orDefault(d.getenv("CAO_COLLECT_WORKERS"), "0")),
		detail("queueMaxLength", orDefault(d.getenv("CAO_COLLECT_QUEUE_MAX_LENGTH"), "default")),
		detail("retainGenerations", orDefault(d.getenv("CAO_COLLECT_RETAIN_GENERATIONS"), "default")),
		detail("inventoryLimit", orDefault(d.getenv("CAO_COLLECT_INVENTORY_LIMIT"), "unbounded")),
		detail("projectionInterval", orDefault(d.getenv("CAO_COLLECT_PROJECTION_INTERVAL"), "default")),
	}
	if keyErr != nil {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "the configured private key file is unusable: " + keyErr.Error(),
			Details: details,
			Remedy:  "confirm CAO_COLLECT_PRIVATE_KEY_FILE points at a readable mounted secret",
		}
	}
	// A placeholder stands in for the key: Validate only tests for presence,
	// so the real bytes are never read here.
	var placeholder []byte
	if keyPresent {
		placeholder = []byte("configured")
	}
	config := server.CollectorConfig{
		AppID:             appID,
		AdmitOnly:         profile.admitOnly,
		PrivateKeyPEM:     placeholder,
		LakeDirectory:     d.getenv("CAO_COLLECT_LAKE_DIRECTORY"),
		CatalogRoot:       d.getenv("CAO_COLLECT_CATALOG_ROOT"),
		ControlRepository: d.getenv("CAO_COLLECT_CONTROL_REPOSITORY"),
		Workers:           intEnv(d.getenv("CAO_COLLECT_WORKERS")),
		RecoverDeliveries: envTruthy(d.getenv("CAO_COLLECT_RECOVER_DELIVERIES")),
	}
	if err := config.Validate(); err != nil {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "the collection configuration is not usable: " + err.Error(),
			Details: details,
			Remedy:  "correct the CAO_COLLECT_* environment before starting the collector",
		}
	}
	if d.getenv("CAO_GITHUB_WEBHOOK_SECRET") == "" && profile.admitOnly {
		// Without a secret the server cannot verify a delivery, so admission
		// has no way to distinguish GitHub from anyone else.
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "no webhook secret is configured; deliveries cannot be verified",
			Details: details,
			Remedy:  "set CAO_GITHUB_WEBHOOK_SECRET to the App's webhook secret",
		}
	}
	if d.getenv("CAO_GITHUB_WEBHOOK_SECRET") == "" {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: "collection workers are configured, but this environment cannot admit webhooks",
			Details: details,
			Remedy:  "this is expected in a worker-only process; a process that serves the webhook endpoint must configure CAO_GITHUB_WEBHOOK_SECRET",
		}
	}
	if profile.admitOnly {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusPass,
			Summary: "admission-only collection is configured and holds no App private key",
			Details: details,
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("collection is configured for App %d", appID),
		Details: details,
	}
}

// privateKeySource reports where the App private key comes from without
// reading it. The file is stat-ed, never opened.
func (d Doctor) privateKeySource() (label string, present bool, err error) {
	if path := d.getenv("CAO_COLLECT_PRIVATE_KEY_FILE"); path != "" {
		info, statErr := os.Stat(path)
		if statErr != nil {
			return "file (unreadable)", false, statErr
		}
		if info.IsDir() {
			return "file (not a file)", false, fmt.Errorf("%s is a directory", path)
		}
		return "file (configured)", true, nil
	}
	if d.getenv("CAO_COLLECT_PRIVATE_KEY") != "" {
		return "inline environment variable (configured)", true, nil
	}
	return "absent", false, nil
}

func (d Doctor) collectEnrollment() collect.Enrollment {
	return collect.Enrollment{Store: d.Store}
}

func (d Doctor) collectQueue() collect.Queue {
	return collect.Queue{Store: d.Store, MaxLength: int64(d.queueMaxLength())}
}

func (d Doctor) queueMaxLength() int {
	if value := intEnv(d.getenv("CAO_COLLECT_QUEUE_MAX_LENGTH")); value > 0 {
		return value
	}
	return 200_000
}

func (d Doctor) checkEnrollment(ctx context.Context) Check {
	const id, title = "collect.enrollment", "Ingestion scope"
	if !d.profile().collecting {
		return skipped(id, areaCollect, title, "collection is not configured")
	}
	if skip, ok := d.storeUnavailable(id, areaCollect, title); ok {
		return skip
	}
	coverage, err := d.collectEnrollment().Coverage(ctx)
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	details := []Detail{
		detail("installations", fmt.Sprint(coverage.Installations)),
		detail("repositories", fmt.Sprint(coverage.Repositories)),
	}
	if coverage.Repositories == 0 {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: "no repositories are enrolled, so nothing is in ingestion scope",
			Details: details,
			Remedy:  "run `cao-dashboard backfill` to enumerate installations, or install the App on a repository",
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%d repositories across %d installations", coverage.Repositories, coverage.Installations),
		Details: details,
	}
}

func (d Doctor) checkQueue(ctx context.Context) Check {
	const id, title = "collect.queue", "Collection queue"
	if !d.profile().collecting {
		return skipped(id, areaCollect, title, "collection is not configured")
	}
	if skip, ok := d.storeUnavailable(id, areaCollect, title); ok {
		return skip
	}
	queue := d.collectQueue()
	depth, err := queue.Depth(ctx)
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	pending, err := queue.Pending(ctx)
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	deadLetters, err := queue.DeadLetters(ctx)
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	maximum := d.queueMaxLength()
	details := []Detail{
		detail("backlog", fmt.Sprint(depth)),
		detail("pending", fmt.Sprint(pending)),
		detail("deadLetters", fmt.Sprint(deadLetters)),
		detail("maxLength", fmt.Sprint(maximum)),
	}
	if deadLetters > 0 {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("%d tasks exhausted their retries and were dead-lettered", deadLetters),
			Details: details,
			Remedy:  "these repositories are not being collected; inspect the dead-letter stream for the failing reason",
		}
	}
	// The stream is trimmed at MaxLength, so a backlog approaching it means
	// work is about to be discarded rather than merely delayed.
	if maximum > 0 && depth >= int64(maximum*8/10) {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("the backlog of %d is within twenty percent of the %d bound", depth, maximum),
			Details: details,
			Remedy:  "workers are not keeping up and trimming will start discarding tasks; scale collection workers",
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("backlog %d, pending %d, no dead letters", depth, pending),
		Details: details,
	}
}

func (d Doctor) checkBackfill(ctx context.Context) Check {
	const id, title = "collect.backfill", "Cold start"
	if !d.profile().collecting {
		return skipped(id, areaCollect, title, "collection is not configured")
	}
	if skip, ok := d.storeUnavailable(id, areaCollect, title); ok {
		return skip
	}
	state, err := collect.Backfill{Store: d.Store}.State(ctx)
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	details := []Detail{
		detail("phase", state.Phase),
		detail("installations", fmt.Sprint(state.Installations)),
		detail("repositories", fmt.Sprint(state.Repositories)),
		detail("queuedRepositories", fmt.Sprint(state.QueuedRepositories)),
		detail("lakeReplayed", fmt.Sprint(state.LakeReplayed)),
		detail("startedAt", orDefault(state.StartedAt, "(never)")),
		detail("completedAt", orDefault(state.CompletedAt, "(not completed)")),
	}
	if state.Error != "" {
		details = append(details, detail("error", state.Error))
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "the last cold start reported an error",
			Details: details,
			Remedy:  "re-run `cao-dashboard backfill`; cold start is idempotent and resumes from its checkpoint",
		}
	}
	if state.Phase == "idle" {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: "cold start has never run in this namespace",
			Details: details,
			Remedy:  "run `cao-dashboard backfill` so an empty database is repopulated from installations and the evidence lake",
		}
	}
	status := StatusPass
	remedy := ""
	if state.Phase != "complete" {
		status = StatusWarn
		remedy = "cold start did not reach the complete phase; re-run `cao-dashboard backfill` to resume"
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: status,
		Summary: fmt.Sprintf("cold start is in the %q phase", state.Phase),
		Details: details, Remedy: remedy,
	}
}

// checkBudget reads the recorded GitHub rate-limit headroom. It reads Redis
// only: the doctor never spends a GitHub request to report on rate limits.
func (d Doctor) checkBudget(ctx context.Context) Check {
	const id, title = "collect.budget", "GitHub rate-limit headroom"
	profile := d.profile()
	if !profile.collecting {
		return skipped(id, areaCollect, title, "collection is not configured")
	}
	if profile.admitOnly {
		return skipped(id, areaCollect, title, "admission-only collection never calls GitHub")
	}
	if skip, ok := d.storeUnavailable(id, areaCollect, title); ok {
		return skip
	}
	floor := intEnv(d.getenv("CAO_COLLECT_RATE_LIMIT_FLOOR"))
	reporter := collect.Reporter{
		Enrollment: d.collectEnrollment(),
		Queue:      d.collectQueue(),
		Backfill:   collect.Backfill{Store: d.Store},
		Budget:     &githubapp.Budget{Store: d.Store, Floor: floor},
		Store:      d.Store,
	}
	status, err := reporter.Snapshot(ctx)
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	if len(status.RateLimits) == 0 {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusSkip,
			Summary: "no rate-limit headroom has been recorded yet",
		}
	}
	var parked, low []string
	details := make([]Detail, 0, len(status.RateLimits)+1)
	details = append(details, detail("floor", orDefault(fmt.Sprint(floor), "default")))
	for _, headroom := range status.RateLimits {
		label := fmt.Sprintf("%d remaining", headroom.Remaining)
		if headroom.ParkedUntil != "" {
			label += ", parked until " + headroom.ParkedUntil
			parked = append(parked, fmt.Sprint(headroom.InstallationID))
		} else if floor > 0 && headroom.Remaining <= floor {
			low = append(low, fmt.Sprint(headroom.InstallationID))
		}
		details = append(details, detail("installation "+fmt.Sprint(headroom.InstallationID), label))
	}
	if len(parked) > 0 {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("%d installations are parked on a rate limit", len(parked)),
			Details: details,
			Remedy:  "collection for these installations is paused until the limit resets; this is the budget working, not a fault",
		}
	}
	if len(low) > 0 {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("%d installations are at or below the configured rate-limit floor", len(low)),
			Details: details,
			Remedy:  "collection will stop short rather than exhaust the installation; widen the window or lower the run limit",
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%d installations have recorded rate-limit headroom", len(status.RateLimits)),
		Details: details,
	}
}

// checkLake inspects the evidence lake, which is what makes a cold start a
// local replay instead of a full re-collection from GitHub.
func (d Doctor) checkLake(context.Context) Check {
	const id, title = "collect.lake", "Evidence lake"
	profile := d.profile()
	if !profile.collecting {
		return skipped(id, areaCollect, title, "collection is not configured")
	}
	if profile.admitOnly {
		return skipped(id, areaCollect, title, "admission-only collection holds no evidence lake")
	}
	directory := d.getenv("CAO_COLLECT_LAKE_DIRECTORY")
	if directory == "" {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "no evidence lake directory is configured",
			Remedy:  "set CAO_COLLECT_LAKE_DIRECTORY to a durable absolute path",
		}
	}
	lake := collect.Lake{Directory: directory}
	if err := lake.Validate(); err != nil {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "the evidence lake directory is not usable: " + err.Error(),
			Details: []Detail{detail("directory", directory)},
			Remedy:  "the lake must be an absolute path on durable storage",
		}
	}
	info, err := os.Stat(directory)
	if err != nil {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusFail,
			Summary: "the evidence lake directory could not be read: " + err.Error(),
			Details: []Detail{detail("directory", directory)},
			Remedy:  "confirm the volume is mounted and writable by this process",
		}
	}
	shards, shardBytes := directorySize(lake.ShardDirectory())
	runs, runBytes := directorySize(lake.RunsDirectory())
	records, recordBytes := directorySize(lake.RecordsDirectory())
	details := []Detail{
		detail("directory", directory),
		detail("mode", info.Mode().Perm().String()),
		detail("shardFiles", fmt.Sprint(shards)),
		detail("runFiles", fmt.Sprint(runs)),
		detail("recordFiles", fmt.Sprint(records)),
		detail("size", humanBytes(shardBytes+runBytes+recordBytes)),
		detail("manifest", filePresence(lake.ManifestPath())),
		detail("inventory", filePresence(lake.InventoryPath())),
	}
	populated, err := lake.Populated()
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	if !populated {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusWarn,
			Summary: "the evidence lake holds no replayable evidence",
			Details: details,
			Remedy:  "until it is populated, a cold start must re-collect from GitHub rather than replay locally",
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%s of replayable evidence across %d run shards",
			humanBytes(shardBytes+runBytes+recordBytes), runs),
		Details: details,
	}
}

// checkProjectionLock reports whether a projection is in flight. The lock has
// a time to live, so a held lock is information rather than a fault.
func (d Doctor) checkProjectionLock(ctx context.Context) Check {
	const id, title = "collect.projection", "Projection lock"
	if skip, ok := d.storeUnavailable(id, areaCollect, title); ok {
		return skip
	}
	held, err := d.Store.LockHeld(ctx, "projection")
	if err != nil {
		return failed(id, areaCollect, title, err)
	}
	if held {
		return Check{
			ID: id, Area: areaCollect, Title: title, Status: StatusPass,
			Summary: "a projection currently holds the lock",
			Details: []Detail{detail("held", "true")},
		}
	}
	return Check{
		ID: id, Area: areaCollect, Title: title, Status: StatusPass,
		Summary: "no projection is in flight",
		Details: []Detail{detail("held", "false")},
	}
}

// checkTooling confirms the external programs collection shells out to are
// actually present, which is the difference between a working collector and
// one that fails on its first task.
func (d Doctor) checkTooling(context.Context) Check {
	const id, title = "runtime.tooling", "Collection tooling"
	profile := d.profile()
	if !profile.collecting || profile.admitOnly {
		return skipped(id, areaRuntime, title, "this process does not run the collection CLI")
	}
	node := orDefault(d.getenv("CAO_COLLECT_NODE_BINARY"), "node")
	gh := orDefault(d.getenv("CAO_COLLECT_GH_BINARY"), "gh")
	catalog := d.getenv("CAO_COLLECT_CATALOG_ROOT")
	script := ""
	if catalog != "" {
		script = filepath.Join(catalog, "activity", "cao.mjs")
	}
	details := []Detail{
		detail("node", binaryPresence(node)),
		detail("gh", binaryPresence(gh)),
		detail("activityCli", orDefault(filePresence(script), "(no catalog root configured)")),
	}
	var missing []string
	if _, err := exec.LookPath(node); err != nil {
		missing = append(missing, "node")
	}
	if _, err := exec.LookPath(gh); err != nil {
		missing = append(missing, "gh")
	}
	if script == "" {
		missing = append(missing, "catalog root")
	} else if _, err := os.Stat(script); err != nil {
		missing = append(missing, "activity/cao.mjs")
	}
	if len(missing) > 0 {
		return Check{
			ID: id, Area: areaRuntime, Title: title, Status: StatusFail,
			Summary: "collection tooling is missing: " + strings.Join(missing, ", "),
			Details: details,
			Remedy:  "collection shells out to these; without them every task fails at the first step",
		}
	}
	return Check{
		ID: id, Area: areaRuntime, Title: title, Status: StatusPass,
		Summary: "node, gh, and the activity CLI are all available",
		Details: details,
	}
}

func presence(value string) string {
	if strings.TrimSpace(value) == "" {
		return "absent"
	}
	return "configured"
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func intEnv(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	return parsed
}

func filePresence(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	return fmt.Sprintf("present (%s, modified %s)", humanBytes(info.Size()),
		info.ModTime().UTC().Format(time.RFC3339))
}

func binaryPresence(name string) string {
	resolved, err := exec.LookPath(name)
	if err != nil {
		return name + " (not found)"
	}
	return resolved
}

// directorySize counts the files and bytes in one lake directory. A missing
// directory reports zero rather than an error, because an unpopulated lake is
// a state the caller reports, not a failure to observe it.
func directorySize(directory string) (files int, bytes int64) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return 0, 0
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files++
		bytes += info.Size()
	}
	return files, bytes
}
