package doctor

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

// Doctor runs the check-up.
//
// Every field the checks need is injected rather than read from a package
// global, so a test can drive the whole report deterministically.
type Doctor struct {
	// Store is the namespaced Redis store to inspect. A nil store limits the
	// report to the checks that need no Redis.
	Store *redisx.Store
	// RedisURL is the configured endpoint. It is redacted before it reaches
	// the report, so a URL carrying a password never appears in output.
	RedisURL string
	// Namespace is the normalized Redis namespace.
	Namespace string
	// DatabaseQueriesPath is the canonical projection query document.
	DatabaseQueriesPath string
	// Version is the server build version.
	Version string
	// Deep enables probes that read real data rather than only metadata.
	Deep bool
	// Timeout bounds each individual check, so one unresponsive dependency
	// cannot hang the whole check-up.
	Timeout time.Duration
	// Now and Getenv are injected so a test controls time and environment.
	Now    func() time.Time
	Getenv func(string) string
}

func (d Doctor) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d Doctor) getenv(name string) string {
	if d.Getenv != nil {
		return strings.TrimSpace(d.Getenv(name))
	}
	return strings.TrimSpace(os.Getenv(name))
}

func (d Doctor) timeout() time.Duration {
	if d.Timeout > 0 {
		return d.Timeout
	}
	return 10 * time.Second
}

// check is one diagnostic function. Returning an error is how a check reports
// that it could not complete; the runner turns that into a failure rather than
// letting it abort the report, because a check-up that stops at the first
// problem is far less useful than one that reports every problem at once.
type check func(context.Context) Check

// Run performs the check-up and returns the report.
//
// Run never returns an error. A check that cannot complete is reported as a
// failed check, which is the diagnostic answer the caller asked for.
func (d Doctor) Run(ctx context.Context) Report {
	wallStarted := time.Now()
	started := d.now()
	profile := d.profile()
	report := Report{
		SchemaVersion: ReportSchemaVersion,
		Tool:          "cao-dashboard doctor",
		Version:       d.Version,
		GeneratedAt:   started.UTC().Format(time.RFC3339),
		Profile:       profile.label,
		Namespace:     d.Namespace,
		Redis:         redactRedisURL(d.RedisURL),
		Deep:          d.Deep,
	}
	checks := []check{
		d.checkBuild,
		d.checkRedisConnectivity,
		d.checkRedisServer,
		d.checkRedisMemory,
		d.checkRedisStats,
		d.checkRedisPersistence,
		d.checkRedisClients,
		d.checkRedisTransport,
		d.checkRedisNamespace,
		d.checkActiveGeneration,
		d.checkSchemaVersion,
		d.checkIntegrity,
		d.checkSources,
		d.checkGenerations,
		d.checkQueryDefinitions,
		d.checkSourceReads,
		d.checkCollectionProfile,
		d.checkCollectionSettings,
		d.checkEnrollment,
		d.checkQueue,
		d.checkBackfill,
		d.checkBudget,
		d.checkLake,
		d.checkTooling,
		d.checkProjectionLock,
	}
	for _, run := range checks {
		checkCtx, cancel := context.WithTimeout(ctx, d.timeout())
		begun := time.Now()
		result := run(checkCtx)
		cancel()
		result.DurationMS = time.Since(begun).Milliseconds()
		report.Checks = append(report.Checks, result)
	}
	sortChecks(report.Checks)
	report.Summary = summarize(report.Checks, time.Since(wallStarted))
	return report
}

// profileSelection is what the environment says this process is.
type profileSelection struct {
	label      string
	collecting bool
	admitOnly  bool
	conflict   bool
}

func (d Doctor) profile() profileSelection {
	appID := d.getenv("CAO_COLLECT_APP_ID")
	source := d.getenv("CAO_SOURCE_DIRECTORY")
	admitOnly := envTruthy(d.getenv("CAO_COLLECT_ADMIT_ONLY"))
	switch {
	case appID != "" && source != "":
		// The two acquisition profiles are alternatives, never layers. A
		// process configured for both would collect and ingest published
		// snapshots into the same namespace.
		return profileSelection{label: "conflicting (collection and published-snapshot ingestion)", conflict: true, collecting: true, admitOnly: admitOnly}
	case appID != "" && admitOnly:
		return profileSelection{label: "collection (admission only)", collecting: true, admitOnly: true}
	case appID != "":
		return profileSelection{label: "collection (webhook-driven)", collecting: true}
	default:
		return profileSelection{label: "actions (published-snapshot ingestion)"}
	}
}

func envTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// redactRedisURL removes credentials from a Redis URL so the endpoint can be
// reported without leaking a password into logs, files, or an agent transcript.
func redactRedisURL(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "(not configured)"
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "(unparsable)"
	}
	scheme := parsed.Scheme
	host := parsed.Host
	if parsed.User != nil {
		if username := parsed.User.Username(); username != "" {
			host = username + ":***@" + host
		} else {
			host = "***@" + host
		}
	}
	path := parsed.Path
	return scheme + "://" + host + path
}

// storeUnavailable is the shared skip used by every check that needs Redis
// when no store was configured.
func (d Doctor) storeUnavailable(id, area, title string) (Check, bool) {
	if d.Store != nil {
		return Check{}, false
	}
	return Check{
		ID: id, Area: area, Title: title, Status: StatusFail,
		Summary: "Redis is not configured, so this check could not run",
		Remedy:  "pass --redis-url or set CAO_REDIS_URL",
	}, true
}

func failed(id, area, title string, err error) Check {
	return Check{
		ID: id, Area: area, Title: title, Status: StatusFail,
		Summary: "check could not complete: " + err.Error(),
	}
}

// redisInfo runs INFO for one section and parses the field:value lines.
//
// INFO is the only way to observe the server's own configuration without
// CONFIG GET, which a managed Redis commonly disables.
func (d Doctor) redisInfo(ctx context.Context, section string) (map[string]string, error) {
	value, err := d.Store.Client.Do(ctx, "INFO", section)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, errors.New("INFO returned no data")
	}
	fields := map[string]string{}
	for _, line := range strings.Split(fmt.Sprint(value), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, content, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields[strings.TrimSpace(name)] = strings.TrimSpace(content)
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("INFO %s returned no fields", section)
	}
	return fields, nil
}

func infoInt(fields map[string]string, name string) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(fields[name]), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// scanKeys walks the keyspace for a pattern up to a bounded number of keys.
//
// The bound matters: the doctor must never be the reason a production Redis
// stalls, so it samples rather than enumerating an arbitrarily large keyspace,
// and reports that it sampled.
func (d Doctor) scanKeys(ctx context.Context, pattern string, limit int) (keys []string, complete bool, err error) {
	cursor := "0"
	for {
		value, err := d.Store.Client.Do(ctx, "SCAN", cursor, "MATCH", pattern, "COUNT", "500")
		if err != nil {
			return keys, false, err
		}
		items, ok := value.([]any)
		if !ok || len(items) != 2 {
			return keys, false, errors.New("unexpected SCAN reply")
		}
		cursor = fmt.Sprint(items[0])
		batch, ok := items[1].([]any)
		if !ok {
			return keys, false, errors.New("unexpected SCAN key list")
		}
		for _, entry := range batch {
			if entry == nil {
				continue
			}
			keys = append(keys, fmt.Sprint(entry))
			if len(keys) >= limit {
				return keys, false, nil
			}
		}
		if cursor == "0" || cursor == "" {
			return keys, true, nil
		}
	}
}

func sortedKeys[V any](values map[string]V) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// humanBytes formats a byte count for a person without losing the exact value,
// which the caller reports separately when it matters.
func humanBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	divisor, exponent := int64(unit), 0
	for size := bytes / unit; size >= unit; size /= unit {
		divisor *= unit
		exponent++
	}
	return fmt.Sprintf("%.1f %ciB", float64(bytes)/float64(divisor), "KMGTPE"[exponent])
}

// humanDuration formats an age so staleness reads at a glance.
func humanDuration(value time.Duration) string {
	if value < time.Minute {
		return fmt.Sprintf("%ds", int(value.Seconds()))
	}
	if value < time.Hour {
		return fmt.Sprintf("%dm", int(value.Minutes()))
	}
	if value < 48*time.Hour {
		return fmt.Sprintf("%.1fh", value.Hours())
	}
	return fmt.Sprintf("%.1fd", value.Hours()/24)
}
