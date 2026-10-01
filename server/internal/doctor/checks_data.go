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
)

const (
	areaData  = "data"
	areaQuery = "query"
)

// staleDatasetAge is when an unchanged canonical database stops looking
// like a quiet deployment and starts looking like a stalled one. Both profiles
// project at least daily when healthy.
const staleDatasetAge = 24 * time.Hour

func (d Doctor) checkActiveDataset(ctx context.Context) Check {
	const id, title = "data.active", "Published canonical dataset"
	if skip, ok := d.storeUnavailable(id, areaData, title); ok {
		return skip
	}
	active, err := d.Store.Active(ctx)
	if err != nil {
		return failed(id, areaData, title, err)
	}
	if active.Revision == 0 {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: "no dataset is published; the dashboard has no data to serve",
			Remedy:  "run `cao-dashboard ingest --source DIRECTORY`, or `cao-dashboard backfill` in the collection profile",
		}
	}
	age := d.now().Sub(active.Activated)
	details := []Detail{
		detail("revision", fmt.Sprint(active.Revision)),
		detail("dataRevision", active.DataRevision),
		detail("evaluatedAt", formatTime(active.EvaluatedAt)),
		detail("activatedAt", formatTime(active.Activated)),
		detail("age", humanDuration(age)),
	}
	if !active.Activated.IsZero() && age > staleDatasetAge {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("the published dataset was activated %s ago", humanDuration(age)),
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
	if active.Revision == 0 {
		return skipped(id, areaData, title, "there is no published dataset to read a schema version from")
	}
	diagnostics, err := d.Store.ReadDiagnostics(ctx)
	if err != nil {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusWarn,
			Summary: "the published dataset carries no diagnostics: " + err.Error(),
			Remedy:  "reproject; a dataset without diagnostics predates the current ingestion path",
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
	if active.Revision == 0 {
		return skipped(id, areaData, title, "there is no published dataset to inspect")
	}
	diagnostics, err := d.Store.ReadDiagnostics(ctx)
	if err != nil {
		return skipped(id, areaData, title, "the published dataset carries no diagnostics")
	}
	classification := classifyIntegrityDiagnostics(diagnostics.RelationshipErrors, diagnostics.DuplicateRecordIDs)
	doctorLog.Printf("canonical integrity classified status=%s reason=%s", classification.status, classification.reason)
	details := []Detail{
		detail("relationshipErrors", fmt.Sprint(len(diagnostics.RelationshipErrors))),
		detail("duplicateRecordIds", fmt.Sprint(classification.duplicates)),
	}
	if len(classification.sample) > 0 {
		details = append(details, detail("sample", strings.Join(classification.sample, "; ")))
	}
	return Check{
		ID: id, Area: areaData, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
	}
}

// integrityReason names why classifyIntegrityDiagnostics reached its status,
// stable across summary wording changes so it is useful to log without
// exposing relationship-error or record-identifier samples.
type integrityReason string

const (
	integrityReasonRelationshipErrors integrityReason = "relationship-errors"
	integrityReasonDuplicateRecords   integrityReason = "duplicate-records"
	integrityReasonHealthy            integrityReason = "healthy"
)

// integrityClassification is the status, summary, remedy, reason, duplicate
// count, and bounded relationship-error sample classifyIntegrityDiagnostics
// derives from one dataset's stored diagnostics.
type integrityClassification struct {
	status     Status
	summary    string
	remedy     string
	reason     integrityReason
	duplicates int
	sample     []string
}

// classifyIntegrityDiagnostics decides the data.integrity check's outcome
// from a dataset's recorded relationship errors and duplicate record
// identifiers alone. It is a pure function so both failure modes — dangling
// relationships and duplicated identifiers — and the bounded three-item
// sample are testable without a fake Redis-backed diagnostics read.
func classifyIntegrityDiagnostics(relationshipErrors []string, duplicateRecordIDs map[string][]string) integrityClassification {
	duplicates := 0
	for _, identifiers := range duplicateRecordIDs {
		duplicates += len(identifiers)
	}
	if len(relationshipErrors) > 0 {
		// Report a bounded sample: the full list can be large and the first
		// few are enough to identify the pattern.
		sample := relationshipErrors
		if len(sample) > 3 {
			sample = sample[:3]
		}
		return integrityClassification{
			status:     StatusFail,
			summary:    fmt.Sprintf("%d relationship errors in the published dataset", len(relationshipErrors)),
			remedy:     "the projection published records that reference missing records; reproject from a complete source",
			reason:     integrityReasonRelationshipErrors,
			duplicates: duplicates,
			sample:     sample,
		}
	}
	if duplicates > 0 {
		return integrityClassification{
			status: StatusWarn,
			summary: fmt.Sprintf("%d duplicate record identifiers across %d collections",
				duplicates, len(duplicateRecordIDs)),
			remedy:     "duplicated identifiers inflate counts; check the source shards for repeated payloads",
			reason:     integrityReasonDuplicateRecords,
			duplicates: duplicates,
		}
	}
	return integrityClassification{
		status:     StatusPass,
		summary:    "no relationship errors or duplicate identifiers",
		reason:     integrityReasonHealthy,
		duplicates: duplicates,
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
	if active.Revision == 0 {
		return skipped(id, areaData, title, "there is no published dataset to inspect")
	}
	if len(active.Counts) == 0 {
		return Check{
			ID: id, Area: areaData, Title: title, Status: StatusFail,
			Summary: "the published dataset published no sources",
			Remedy:  "reproject; an activated dataset with no sources serves an empty dashboard",
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

type queryDefinitionNames struct {
	seen       map[string]int
	duplicates []string
	unnamed    []string
}

// classifyQueryDefinitionNames finds duplicate and unnamed query
// definitions. It is a pure function so every naming defect is testable
// without a canonical query document on disk.
func classifyQueryDefinitionNames(definitions []query.Definition) queryDefinitionNames {
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
	sort.Strings(duplicates)
	return queryDefinitionNames{seen: seen, duplicates: duplicates, unnamed: unnamed}
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
	names := classifyQueryDefinitionNames(definitions)
	doctorLog.Printf("query definitions classified total=%d duplicates=%d unnamed=%d",
		len(definitions), len(names.duplicates), len(names.unnamed))
	if len(names.duplicates) > 0 {
		details = append(details, detail("duplicates", strings.Join(names.duplicates, ", ")))
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d query names are defined more than once", len(names.duplicates)),
			Details: details,
			Remedy:  "a duplicated name silently shadows the earlier definition; keep one definition per name",
		}
	}
	if len(names.unnamed) > 0 {
		return Check{
			ID: id, Area: areaQuery, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("%d queries have no name", len(names.unnamed)),
			Details: details,
			Remedy:  "projection resolves queries by name; an unnamed query can never be selected",
		}
	}
	// A definition that no active source satisfies is a real signal, but only
	// once there is data to compare against.
	if d.Store != nil {
		if active, err := d.Store.Active(ctx); err == nil && len(active.Counts) > 0 {
			var missing []string
			for name := range names.seen {
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

// sourceReadProbeReason names why checkSourceReads reached its status,
// stable across summary wording changes so it is useful to log without
// exposing the per-source names, row counts, or read errors it classifies.
type sourceReadProbeReason string

const (
	sourceReadProbeReasonFailures    sourceReadProbeReason = "failures"
	sourceReadProbeReasonNearLimit   sourceReadProbeReason = "near-limit"
	sourceReadProbeReasonAllReadable sourceReadProbeReason = "all-readable"
)

// sourceReadProbeClassification is the status, summary, and remedy
// classifySourceReadProbe derives from a dataset's per-source read
// results.
type sourceReadProbeClassification struct {
	status  Status
	summary string
	remedy  string
	reason  sourceReadProbeReason
}

// classifySourceReadProbe decides the query.reads check's outcome from the
// read failures and near-row-limit sources checkSourceReads collected, plus
// the total source and row counts. It is a pure function so the
// failures-outrank-warnings precedence is testable without a real Redis
// store or dataset.
func classifySourceReadProbe(failures, near []string, sourceCount, totalRows, maxInputRows int) sourceReadProbeClassification {
	if len(failures) > 0 {
		return sourceReadProbeClassification{
			status:  StatusFail,
			summary: fmt.Sprintf("%d of %d sources did not read back correctly", len(failures), sourceCount),
			remedy:  "the stored dataset is inconsistent with its recorded counts; reproject",
			reason:  sourceReadProbeReasonFailures,
		}
	}
	if len(near) > 0 {
		return sourceReadProbeClassification{
			status:  StatusWarn,
			summary: fmt.Sprintf("%d sources are within ten percent of the %d row read limit", len(near), maxInputRows),
			remedy:  "a source that crosses the limit stops being readable entirely; narrow the collection window or retention",
			reason:  sourceReadProbeReasonNearLimit,
		}
	}
	return sourceReadProbeClassification{
		status:  StatusPass,
		summary: fmt.Sprintf("all %d sources read back %d rows matching their recorded counts", sourceCount, totalRows),
		reason:  sourceReadProbeReasonAllReadable,
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
	if active.Revision == 0 {
		return skipped(id, areaQuery, title, "there is no published dataset to read")
	}
	var failures []string
	var slowest string
	var slowestDuration time.Duration
	totalRows, near := 0, []string{}
	for _, name := range sortedKeys(active.Counts) {
		started := time.Now()
		source, _, err := d.Store.ReadSource(ctx, name, nil)
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
				fmt.Sprintf("%s: read %d rows but the dataset records %d", name, len(source.Rows), count))
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
	}
	if len(near) > 0 {
		details = append(details, detail("nearRowLimit", strings.Join(near, ", ")))
	}
	classification := classifySourceReadProbe(failures, near, len(active.Counts), totalRows, query.MaxInputRows)
	doctorLog.Printf("source read probe classified status=%s reason=%s", classification.status, classification.reason)
	return Check{
		ID: id, Area: areaQuery, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
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
