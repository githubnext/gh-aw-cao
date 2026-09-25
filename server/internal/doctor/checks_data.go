package doctor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	areaData  = "data"
	areaQuery = "query"
)

// staleGenerationAge is when an unchanged canonical database stops looking
// like a quiet deployment and starts looking like a stalled one. Both profiles
// project at least daily when healthy.
const staleGenerationAge = 24 * time.Hour

func (d Doctor) checkActiveGeneration(ctx context.Context) Check {
	const id, title = "data.active", "Active canonical generation"
	if skip, ok := d.storeUnavailable(id, areaData, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	if active.Generation == "" {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: "no generation is active; the dashboard has no data to serve",
			Remedy:  "run `cao-dashboard ingest --source DIRECTORY`, or `cao-dashboard backfill` in the collection profile",
		}
	}
	age := d.now().Sub(active.Activated)
	details := []Detail{
		detail("generation", active.Generation),
		detail("revision", fmt.Sprint(active.Revision)),
		detail("dataRevision", active.DataRevision),
		detail("evaluatedAt", formatTime(active.EvaluatedAt)),
		detail("activatedAt", formatTime(active.Activated)),
		detail("age", humanDuration(age)),
	}
	if !active.Activated.IsZero() && age > staleGenerationAge {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("the active generation was activated %s ago", humanDuration(age)),
			Details: details,
			Remedy:  "check that projection is still running; the dashboard is serving data that is no longer current",
		}
	}
	return Check{
		ID: id, Area: areaData, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("revision %d activated %s ago", active.Revision, humanDuration(age)),
		Details: details,
	}
}

// checkSchemaVersion catches the mismatch that silently renders an empty or
// wrong dashboard: data written by one schema version read by another.
func (d Doctor) checkSchemaVersion(ctx context.Context) Check {
	const id, title = "data.schema", "Canonical schema version"
	if skip, ok := d.storeUnavailable(id, areaData, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	if active.Generation == "" {
		return skipped(id, areaData, title, "there is no active generation to read a schema version from")
	}
	diagnostics, err := d.Store.Diagnostics(ctx, active.Generation)
	if err != nil {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: "the active generation carries no diagnostics: " + err.Error(),
			Remedy:  "reproject; a generation without diagnostics predates the current ingestion path",
		}
	}
	details := []Detail{
		detail("stored", fmt.Sprint(diagnostics.SchemaVersion)),
		detail("expected", fmt.Sprint(model.SchemaVersion)),
	}
	if diagnostics.SchemaVersion != model.SchemaVersion {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("stored schema version %d does not match this build's %d",
				diagnostics.SchemaVersion, model.SchemaVersion),
			Details: details,
			Remedy:  "reproject with this build so the stored data matches the reader",
		}
	}
	return Check{
		ID: id, Area: areaData, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("stored data is at schema version %d, matching this build", diagnostics.SchemaVersion),
		Details: details,
	}
}

func (d Doctor) checkIntegrity(ctx context.Context) Check {
	const id, title = "data.integrity", "Canonical integrity"
	if skip, ok := d.storeUnavailable(id, areaData, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	if active.Generation == "" {
		return skipped(id, areaData, title, "there is no active generation to inspect")
	}
	diagnostics, err := d.Store.Diagnostics(ctx, active.Generation)
	if err != nil {
		return skipped(id, areaData, title, "the active generation carries no diagnostics")
	}
	duplicates := 0
	for _, identifiers := range diagnostics.DuplicateRecordIDs {
		duplicates += len(identifiers)
	}
	details := []Detail{
		detail("relationshipErrors", fmt.Sprint(len(diagnostics.RelationshipErrors))),
		detail("duplicateRecordIds", fmt.Sprint(duplicates)),
	}
	if len(diagnostics.RelationshipErrors) > 0 {
		// Report a bounded sample: the full list can be large and the first
		// few are enough to identify the pattern.
		sample := diagnostics.RelationshipErrors
		if len(sample) > 3 {
			sample = sample[:3]
		}
		details = append(details, detail("sample", strings.Join(sample, "; ")))
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d relationship errors in the active generation", len(diagnostics.RelationshipErrors)),
			Details: details,
			Remedy:  "the projection published records that reference missing records; reproject from a complete source",
		}
	}
	if duplicates > 0 {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("%d duplicate record identifiers across %d collections",
				duplicates, len(diagnostics.DuplicateRecordIDs)),
			Details: details,
			Remedy:  "duplicated identifiers inflate counts; check the source shards for repeated payloads",
		}
	}
	return Check{
		ID: id, Area: areaData, Title: title, Status: StatusPass,
		Summary: "no relationship errors or duplicate identifiers",
		Details: details,
	}
}

func (d Doctor) checkSources(ctx context.Context) Check {
	const id, title = "data.sources", "Projected sources"
	if skip, ok := d.storeUnavailable(id, areaData, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	if active.Generation == "" {
		return skipped(id, areaData, title, "there is no active generation to inspect")
	}
	if len(active.Counts) == 0 {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: "the active generation published no sources",
			Remedy:  "reproject; an activated generation with no sources serves an empty dashboard",
		}
	}
	total := 0
	var empty []string
	for _, name := range sortedKeys(active.Counts) {
		count := active.Counts[name]
		total += count
		if count == 0 {
			empty = append(empty, name)
		}
	}
	details := []Detail{
		detail("sources", fmt.Sprint(len(active.Counts))),
		detail("rows", fmt.Sprint(total)),
		detail("largest", largestSource(active.Counts)),
	}
	if len(empty) > 0 {
		details = append(details, detail("emptySources", strings.Join(empty, ", ")))
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusPass,
			Summary: fmt.Sprintf("%d sources holding %d rows; %d sources explicitly published empty",
				len(active.Counts), total, len(empty)),
			Details: details,
		}
	}
	return Check{
		ID: id, Area: areaData, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%d sources holding %d rows", len(active.Counts), total),
		Details: details,
	}
}

func largestSource(counts map[string]int) string {
	name, highest := "", -1
	for _, candidate := range sortedKeys(counts) {
		if counts[candidate] > highest {
			name, highest = candidate, counts[candidate]
		}
	}
	if name == "" {
		return "none"
	}
	return fmt.Sprintf("%s (%d rows)", name, highest)
}

// checkGenerations detects the failure mode that continuous projection
// introduces and snapshot ingestion never showed.
//
// Every projection writes a complete new generation, so without reclamation
// the namespace grows by a full copy of the dataset on every cycle until a
// noeviction Redis refuses all writes. Reclamation runs at activation, so a
// registry that keeps growing, or generation keys with no registry entry, mean
// reclamation is not keeping up or never ran.
func (d Doctor) checkGenerations(ctx context.Context) Check {
	const id, title = "data.generations", "Generation retention"
	if skip, ok := d.storeUnavailable(id, areaData, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	tracked, err := d.trackedGenerations(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	stored, complete, err := d.storedGenerations(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	retention := d.retainGenerations()
	trackedSet := map[string]struct{}{}
	for _, name := range tracked {
		trackedSet[name] = struct{}{}
	}
	var orphans []string
	for _, name := range stored {
		if _, ok := trackedSet[name]; !ok && name != active.Generation {
			orphans = append(orphans, name)
		}
	}
	sort.Strings(orphans)
	details := []Detail{
		detail("tracked", fmt.Sprint(len(tracked))),
		detail("storedGenerations", storedLabel(len(stored), complete)),
		detail("retention", fmt.Sprint(retention)),
		detail("activeTracked", fmt.Sprint(contains(tracked, active.Generation))),
	}
	if len(orphans) > 0 {
		sample := orphans
		if len(sample) > 3 {
			sample = sample[:3]
		}
		details = append(details, detail("untrackedSample", strings.Join(sample, ", ")))
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d generations hold keys but are not in the reclamation registry", len(orphans)),
			Details: details,
			Remedy:  "these generations will never be reclaimed and will grow Redis without bound; drop them and reproject with a build that tracks generations",
		}
	}
	// Retention plus a small allowance: reclamation also honours a grace
	// period, so being one or two over the configured retention is normal.
	if len(tracked) > retention+2 {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("%d generations are retained against a retention of %d", len(tracked), retention),
			Details: details,
			Remedy:  "reclamation is not keeping up; confirm projections are completing and consider lowering CAO_COLLECT_RETAIN_GENERATIONS",
		}
	}
	if active.Generation != "" && !contains(tracked, active.Generation) {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: "the active generation is not in the reclamation registry",
			Details: details,
			Remedy:  "it is safe now, because reclamation never drops the active generation, but it will not be reclaimed after it is superseded",
		}
	}
	return Check{
		ID: id, Area: areaData, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%d generations retained against a retention of %d", len(tracked), retention),
		Details: details,
	}
}

func storedLabel(count int, complete bool) string {
	if complete {
		return fmt.Sprint(count)
	}
	return fmt.Sprintf("at least %d (sampled)", count)
}

func contains(values []string, target string) bool {
	if target == "" {
		return false
	}
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// trackedGenerations reads the reclamation registry.
func (d Doctor) trackedGenerations(ctx context.Context) ([]string, error) {
	value, err := d.Store.Client.Do(ctx, "ZRANGE", d.Namespace+":generations", "0", "-1")
	if err != nil {
		return nil, fmt.Errorf("read generation registry: %w", err)
	}
	if value == nil {
		return nil, nil
	}
	entries, err := redisx.Strings(value)
	if err != nil {
		return nil, fmt.Errorf("decode generation registry: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry != "" {
			names = append(names, entry)
		}
	}
	return names, nil
}

// storedGenerations derives the generations that actually hold keys, which is
// the only way to see a generation the registry has lost track of.
func (d Doctor) storedGenerations(ctx context.Context) ([]string, bool, error) {
	keys, complete, err := d.scanKeys(ctx, d.Namespace+":g:*", 20000)
	if err != nil {
		return nil, false, err
	}
	prefix := d.Namespace + ":g:"
	found := map[string]struct{}{}
	for _, key := range keys {
		remainder := strings.TrimPrefix(key, prefix)
		generation, _, _ := strings.Cut(remainder, ":")
		if generation != "" {
			found[generation] = struct{}{}
		}
	}
	return sortedKeys(found), complete, nil
}

func (d Doctor) retainGenerations() int {
	if raw := d.getenv("CAO_COLLECT_RETAIN_GENERATIONS"); raw != "" {
		var parsed int
		if _, err := fmt.Sscanf(raw, "%d", &parsed); err == nil && parsed > 0 {
			return parsed
		}
	}
	return redisx.DefaultGenerationRetention
}

// checkQueryDefinitions validates the document that drives projection. It is a
// file on disk, so it is the easiest part of the system to deploy wrongly.
func (d Doctor) checkQueryDefinitions(ctx context.Context) Check {
	const id, title = "query.definitions", "Canonical query definitions"
	path := strings.TrimSpace(d.DatabaseQueriesPath)
	if path == "" {
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: "no canonical query document is configured",
			Remedy:  "pass --database-queries",
		}
	}
	// #nosec G304 -- the operator explicitly configures this path, exactly as
	// the ingestion path does.
	content, err := os.ReadFile(path)
	if err != nil {
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: "the canonical query document could not be read: " + err.Error(),
			Details: []Detail{detail("path", path)},
			Remedy:  "point --database-queries at dashboard/site/src/data/queries/database.json",
		}
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: "the canonical query document is not valid: " + err.Error(),
			Details: []Detail{detail("path", path)},
			Remedy:  "restore the document from the catalog; projection cannot run without it",
		}
	}
	details := []Detail{
		detail("path", path),
		detail("definitions", fmt.Sprint(len(definitions))),
		detail("bytes", fmt.Sprint(len(content))),
	}
	if len(definitions) == 0 {
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: "the canonical query document defines no queries",
			Details: details,
			Remedy:  "restore the document from the catalog",
		}
	}
	seen := map[string]int{}
	var duplicates, unnamed []string
	for _, definition := range definitions {
		name := strings.TrimSpace(definition.Name)
		if name == "" {
			unnamed = append(unnamed, definition.From)
			continue
		}
		seen[name]++
		if seen[name] == 2 {
			duplicates = append(duplicates, name)
		}
	}
	if len(duplicates) > 0 {
		sort.Strings(duplicates)
		details = append(details, detail("duplicates", strings.Join(duplicates, ", ")))
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d query names are defined more than once", len(duplicates)),
			Details: details,
			Remedy:  "a duplicated name silently shadows the earlier definition; keep one definition per name",
		}
	}
	if len(unnamed) > 0 {
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d queries have no name", len(unnamed)),
			Details: details,
			Remedy:  "projection resolves queries by name; an unnamed query can never be selected",
		}
	}
	// A definition that no active source satisfies is a real signal, but only
	// once there is data to compare against.
	if d.Store != nil {
		if active, err := d.Store.Active(ctx); err == nil && len(active.Counts) > 0 {
			var missing []string
			for name := range seen {
				if _, ok := active.Counts[name]; !ok {
					missing = append(missing, name)
				}
			}
			sort.Strings(missing)
			if len(missing) > 0 {
				details = append(details, detail("notProjected", strings.Join(missing, ", ")))
				return Check{
					ID: id, Area: areaQuery, Title: title, Status: StatusPass,
					Summary: fmt.Sprintf("%d query definitions parsed; %d conditional sources were not projected",
						len(definitions), len(missing)),
					Details: details,
				}
			}
		}
	}
	return Check{
		ID: id, Area: areaQuery, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%d uniquely named query definitions parsed", len(definitions)),
		Details: details,
	}
}

// checkSourceReads reads every active source the way the dashboard does.
//
// This is the only check that proves the stored rows are actually readable
// rather than merely counted, so it is also the only check expensive enough to
// require opting in.
func (d Doctor) checkSourceReads(ctx context.Context) Check {
	const id, title = "query.reads", "Source read probe"
	if !d.Deep {
		return skipped(id, areaQuery, title, "pass --deep to read every source and confirm the stored rows decode")
	}
	if skip, ok := d.storeUnavailable(id, areaQuery, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaQuery, title, err)
	}
	if active.Generation == "" {
		return skipped(id, areaQuery, title, "there is no active generation to read")
	}
	var failures []string
	var slowest string
	var slowestDuration time.Duration
	totalRows, near := 0, []string{}
	for _, name := range sortedKeys(active.Counts) {
		started := time.Now()
		source, _, err := d.Store.LoadSource(ctx, active.Generation, name, nil)
		elapsed := time.Since(started)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		totalRows += len(source.Rows)
		if elapsed > slowestDuration {
			slowest, slowestDuration = name, elapsed
		}
		// The engine refuses a source above MaxInputRows outright, so a source
		// approaching it is about to stop being readable at all.
		if len(source.Rows) > (query.MaxInputRows*9)/10 {
			near = append(near, fmt.Sprintf("%s (%d rows)", name, len(source.Rows)))
		}
		if count, ok := active.Counts[name]; ok && count != len(source.Rows) {
			failures = append(failures,
				fmt.Sprintf("%s: read %d rows but the generation records %d", name, len(source.Rows), count))
		}
	}
	details := []Detail{
		detail("sources", fmt.Sprint(len(active.Counts))),
		detail("rowsRead", fmt.Sprint(totalRows)),
		detail("maxInputRows", fmt.Sprint(query.MaxInputRows)),
	}
	if slowest != "" {
		details = append(details, detail("slowest", fmt.Sprintf("%s (%s)", slowest, slowestDuration.Round(time.Millisecond))))
	}
	if len(failures) > 0 {
		sample := failures
		if len(sample) > 3 {
			sample = sample[:3]
		}
		details = append(details, detail("failures", strings.Join(sample, "; ")))
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d of %d sources did not read back correctly", len(failures), len(active.Counts)),
			Details: details,
			Remedy:  "the stored generation is inconsistent with its recorded counts; reproject",
		}
	}
	if len(near) > 0 {
		details = append(details, detail("nearRowLimit", strings.Join(near, ", ")))
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("%d sources are within ten percent of the %d row read limit", len(near), query.MaxInputRows),
			Details: details,
			Remedy:  "a source that crosses the limit stops being readable entirely; narrow the collection window or retention",
		}
	}
	return Check{
		ID: id, Area: areaQuery, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("all %d sources read back %d rows matching their recorded counts", len(active.Counts), totalRows),
		Details: details,
	}
}

func skipped(id, area, title, reason string) Check {
	return Check{ID: id, Area: area, Title: title, Status: StatusSkip, Summary: reason}
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return "(never)"
	}
	return value.UTC().Format(time.RFC3339)
}
