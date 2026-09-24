package ingest

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

var collections = []string{"campaigns", "repositories", "workflows", "runs", "domains", "tools", "audits", "issues"}

const projectionBatchSize = 25_000

type Result struct {
	Generation   string         `json:"generation"`
	Revision     int64          `json:"revision"`
	DataRevision string         `json:"dataRevision"`
	EvaluatedAt  string         `json:"evaluatedAt"`
	Counts       map[string]int `json:"counts"`
}

type Options struct {
	DatabaseQueriesPath string
}

type Manifest map[string]string

func ValidateManifest(directory string) (Manifest, []string, []string, error) {
	manifestPath := filepath.Join(directory, "payload-hashes.json")
	// #nosec G304 -- the caller explicitly selects the local deployment directory.
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read payload manifest: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, nil, nil, fmt.Errorf("parse payload manifest: %w", err)
	}
	if len(manifest) == 0 {
		return nil, nil, nil, errors.New("payload manifest is empty")
	}
	var runs, records []string
	for name, expected := range manifest {
		clean := filepath.ToSlash(filepath.Clean(name))
		if clean != name || filepath.IsAbs(name) || strings.HasPrefix(clean, "../") {
			return nil, nil, nil, fmt.Errorf("manifest path %q is unsafe", name)
		}
		verifyContentHash := false
		switch {
		case strings.HasPrefix(name, "gh-aw-logs-runs/") && strings.HasSuffix(name, ".jsonl"):
			runs = append(runs, name)
			verifyContentHash = true
		case strings.HasPrefix(name, "gh-aw-logs-records/") && strings.HasSuffix(name, ".jsonl"):
			records = append(records, name)
			verifyContentHash = true
		case strings.HasPrefix(name, "gh-aw-logs-shards/"):
			return nil, nil, nil, errors.New("raw activity JSONL is not supported; compacted run/record shards are required")
		}
		if len(expected) != 64 {
			return nil, nil, nil, fmt.Errorf("manifest hash for %q is not SHA-256", name)
		}
		if !verifyContentHash {
			continue
		}
		// #nosec G304 -- name is constrained above to a clean relative manifest path.
		payload, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(name)))
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read manifested payload %q: %w", name, err)
		}
		sum := sha256.Sum256(payload)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), expected) {
			return nil, nil, nil, fmt.Errorf("payload hash mismatch for %q", name)
		}
	}
	if len(runs) == 0 {
		return nil, nil, nil, errors.New("activity shard manifest is missing compacted run-information shards")
	}
	sort.Strings(runs)
	sort.Strings(records)
	return manifest, runs, records, nil
}

func DirectoryRevision(manifest Manifest, inventory []byte) string {
	keys := make([]string, 0, len(manifest))
	for key := range manifest {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hasher := sha256.New()
	for _, key := range keys {
		_, _ = io.WriteString(hasher, key+"\x00"+strings.ToLower(manifest[key])+"\x00")
	}
	sum := sha256.Sum256(inventory)
	_, _ = io.WriteString(hasher, "inventory\x00"+hex.EncodeToString(sum[:]))
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

func Run(ctx context.Context, store *redisx.Store, directory string, options Options) (result Result, err error) {
	ctx, span := telemetry.Tracer().Start(ctx, "cao_dashboard.ingest.run")
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		} else {
			span.SetAttributes(
				attribute.Int64("cao_dashboard.ingest.revision", result.Revision),
				attribute.Int("cao_dashboard.ingest.source_count", len(result.Counts)),
			)
			span.SetStatus(codes.Ok, "")
		}
		span.End()
	}()
	manifest, runs, records, err := ValidateManifest(directory)
	if err != nil {
		return Result{}, err
	}
	// #nosec G304 -- the filename is fixed within the caller-selected deployment directory.
	inventoryContent, err := os.ReadFile(filepath.Join(directory, "inventory-sources.json"))
	if err != nil {
		return Result{}, fmt.Errorf("read inventory-sources.json: %w", err)
	}
	inventory, err := parseInventory(inventoryContent)
	if err != nil {
		return Result{}, err
	}
	dataRevision := DirectoryRevision(manifest, inventoryContent)
	active, err := store.Active(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("read active Redis generation: %w", err)
	}
	if active.Generation != "" && active.DataRevision == dataRevision {
		evaluatedAt := active.EvaluatedAt
		if evaluatedAt.IsZero() {
			evaluatedAt = active.Activated
		}
		if evaluatedAt.IsZero() {
			evaluatedAt = time.Unix(0, 0).UTC()
		}
		span.SetAttributes(attribute.Bool("cao_dashboard.ingest.reused_generation", true))
		return Result{
			Generation: active.Generation, Revision: active.Revision,
			DataRevision: dataRevision, EvaluatedAt: evaluatedAt.UTC().Format(time.RFC3339Nano),
			Counts: active.Counts,
		}, nil
	}
	canonical := map[string][]model.Row{}
	for _, name := range collections {
		canonical[name] = []model.Row{}
	}
	for _, name := range append(runs, records...) {
		if err := readShard(filepath.Join(directory, filepath.FromSlash(name)), canonical); err != nil {
			return Result{}, err
		}
	}
	definitions, err := loadDefinitions(options.DatabaseQueriesPath)
	if err != nil {
		return Result{}, err
	}
	sources, err := projectSources(canonical, inventory, definitions)
	if err != nil {
		return Result{}, err
	}
	generation := time.Now().UTC().Format("20060102T150405.000000000Z") + "-" + dataRevision[len(dataRevision)-12:]
	counts := map[string]int{}
	for _, name := range sortedSourceNames(sources) {
		source := sources[name]
		source.Source = name
		if source.Metadata == nil {
			source.Metadata = model.Metadata{}
		}
		source.Metadata["source-id"] = name
		source.Metadata["source-revision"] = dataRevision
		source.Metadata["availability"] = availability(source.Rows)
		source.Metadata["row-count"] = len(source.Rows)
		if _, err := store.PutSource(ctx, generation, source); err != nil {
			return Result{}, fmt.Errorf("stage generation %s: %w", generation, err)
		}
		counts[name] = len(source.Rows)
	}
	diagnostics := buildDiagnostics(canonical)
	if err := store.PutDiagnostics(ctx, generation, diagnostics); err != nil {
		return Result{}, fmt.Errorf("stage diagnostics: %w", err)
	}
	evaluatedAt := sourceEvaluationTime(sources)
	revision, err := store.Activate(ctx, generation, dataRevision, evaluatedAt, counts)
	if err != nil {
		return Result{}, err
	}
	return Result{
		Generation: generation, Revision: revision, DataRevision: dataRevision,
		EvaluatedAt: evaluatedAt.Format(time.RFC3339Nano), Counts: counts,
	}, nil
}

func sourceEvaluationTime(sources map[string]model.Source) time.Time {
	fields := map[string]bool{
		"as-of": true, "retrieved-at": true, "observed-at": true, "observedAt": true,
		"event-timestamp": true, "created-at": true, "createdAt": true,
		"started-at": true, "startedAt": true, "ended-at": true, "completedAt": true,
		"updated-at": true, "updatedAt": true,
	}
	latest := time.Unix(0, 0).UTC()
	consider := func(value any) {
		text, ok := value.(string)
		if !ok {
			return
		}
		instant, err := time.Parse(time.RFC3339Nano, text)
		if err == nil && instant.After(latest) {
			latest = instant.UTC()
		}
	}
	for _, source := range sources {
		for field := range fields {
			consider(source.Metadata[field])
		}
		for _, row := range source.Rows {
			for field := range fields {
				consider(row[field])
			}
		}
	}
	return latest
}

func loadDefinitions(path string) ([]query.Definition, error) {
	if path == "" {
		return nil, errors.New("database query path is required")
	}
	// #nosec G304 -- the operator explicitly configures the local query-definition path.
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read database queries: %w", err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		return nil, fmt.Errorf("parse database queries: %w", err)
	}
	return definitions, nil
}

func parseInventory(content []byte) (map[string]model.Source, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var raw map[string]json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("parse inventory-sources.json: %w", err)
	}
	sources := map[string]model.Source{}
	for name, payload := range raw {
		var source model.Source
		if err := json.Unmarshal(payload, &source); err == nil && source.Rows != nil {
			source.Source = name
			if source.Metadata == nil {
				source.Metadata = model.Metadata{}
			}
			sources[name] = source
			continue
		}
		var rows []model.Row
		if err := json.Unmarshal(payload, &rows); err != nil {
			return nil, fmt.Errorf("inventory source %q must be a LogicalSourceInput or row array", name)
		}
		sources[name] = model.Source{Source: name, Rows: rows, Metadata: model.Metadata{}}
	}
	return sources, nil
}

func readShard(path string, canonical map[string][]model.Row) error {
	// #nosec G304 -- path comes from a manifest entry validated by ValidateManifest.
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() {
		_ = file.Close()
	}()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		if len(bytes.TrimSpace(scanner.Bytes())) == 0 {
			continue
		}
		var envelope struct {
			Kind       string          `json:"kind"`
			Collection string          `json:"collection"`
			Record     json.RawMessage `json:"record"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &envelope); err != nil {
			return fmt.Errorf("%s:%d must contain valid canonical JSON: %w", path, line, err)
		}
		if envelope.Kind != "record" {
			continue
		}
		if _, ok := canonical[envelope.Collection]; !ok {
			return fmt.Errorf("%s:%d has unsupported collection %q", path, line, envelope.Collection)
		}
		var row model.Row
		if err := json.Unmarshal(envelope.Record, &row); err != nil || row == nil {
			return fmt.Errorf("%s:%d record must be an object", path, line)
		}
		canonical[envelope.Collection] = append(canonical[envelope.Collection], row)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("scan %s: %w", path, err)
	}
	return nil
}

func projectSources(canonical map[string][]model.Row, inventory map[string]model.Source, definitions []query.Definition) (map[string]model.Source, error) {
	sources := map[string]model.Source{}
	for name, source := range inventory {
		sources[name] = source
	}
	inputs := map[string]model.Source{}
	for name, rows := range canonical {
		inputs["$"+name] = model.Source{Source: "$" + name, Rows: rows, Metadata: model.Metadata{"availability": availability(rows)}}
	}
	index := map[string]query.Definition{}
	for _, definition := range definitions {
		index[definition.Name] = definition
	}
	execute := func(definition query.Definition, available map[string]model.Source) (model.Source, error) {
		result, _, _, err := query.ExecuteDefinition(definition, available, query.MaxOperations)
		return result, err
	}
	for _, name := range []string{"campaigns", "repositories", "workflows", "runs"} {
		definition, ok := index[name]
		if !ok {
			continue
		}
		available := mergeSourceMaps(inputs, sources)
		result, err := execute(definition, available)
		if err != nil {
			return nil, fmt.Errorf("project %s: %w", name, err)
		}
		sources[name] = mergeLogical(sources[name], result)
	}
	runRecords, ok := index["run-records"]
	if ok {
		for _, name := range []string{"domains", "tools", "audits", "issues"} {
			records := canonical[name]
			projected := model.Source{Source: name, Rows: []model.Row{}, Metadata: model.Metadata{}}
			for offset := 0; offset < max(1, len(records)); offset += projectionBatchSize {
				end := min(len(records), offset+projectionBatchSize)
				batch := records[offset:end]
				available := mergeSourceMaps(sources, map[string]model.Source{
					"$records": {Source: "$records", Rows: batch, Metadata: model.Metadata{}},
					"$runs":    {Source: "$runs", Rows: canonical["runs"], Metadata: model.Metadata{}},
				})
				result, err := execute(runRecords, available)
				if err != nil {
					return nil, fmt.Errorf("project %s batch %d-%d: %w", name, offset, end, err)
				}
				projected.Rows = append(projected.Rows, result.Rows...)
				for key, value := range result.Metadata {
					projected.Metadata[key] = value
				}
				if len(records) == 0 {
					break
				}
			}
			sources[name] = mergeLogical(sources[name], projected)
		}
	}
	for _, name := range []string{"mcp-calls", "findings", "firewall-observations"} {
		definition, exists := index[name]
		if !exists {
			continue
		}
		store := map[string]string{"mcp-calls": "tools", "findings": "audits", "firewall-observations": "domains"}[name]
		available := mergeSourceMaps(sources, map[string]model.Source{"run-records": sources[store]})
		result, err := execute(definition, available)
		if err != nil {
			return nil, fmt.Errorf("project %s: %w", name, err)
		}
		sources[name] = mergeLogical(sources[name], result)
	}
	if definition, exists := index["outcomes"]; exists {
		records := sources["issues"]
		for _, row := range records.Rows {
			correlation := strings.TrimSpace(fmt.Sprint(row["correlation-id"]))
			if correlation == "" || correlation == "<nil>" {
				continue
			}
			label := "View issue"
			if row["is-pull-request"] == true {
				label = "View pull request"
			}
			link := map[string]any{"href": correlation, "label": label}
			if row["is-pull-request"] == true {
				row["pull-request-link"] = link
			} else {
				row["issue-link"] = link
			}
			row["external-link"] = link
		}
		result, err := execute(definition, mergeSourceMaps(sources, map[string]model.Source{"run-records": records}))
		if err != nil {
			return nil, fmt.Errorf("project outcomes: %w", err)
		}
		sources["outcomes"] = mergeLogical(sources["outcomes"], result)
	}
	for _, name := range []string{"detection-observations", "safe-output-performance"} {
		definition, exists := index[name]
		if !exists {
			continue
		}
		logicalName := map[string]string{"detection-observations": "security-findings", "safe-output-performance": "outcomes"}[name]
		inputName := "$" + logicalName
		input, exists := inventory[logicalName]
		if !exists {
			continue
		}
		result, err := execute(definition, mergeSourceMaps(sources, map[string]model.Source{inputName: input}))
		if err != nil {
			return nil, fmt.Errorf("project %s: %w", name, err)
		}
		sources[name] = mergeLogical(sources[name], result)
	}
	return sources, nil
}

func mergeSourceMaps(maps ...map[string]model.Source) map[string]model.Source {
	result := map[string]model.Source{}
	for _, sources := range maps {
		for name, source := range sources {
			result[name] = source
		}
	}
	return result
}

func mergeLogical(left, right model.Source) model.Source {
	sourceName := right.Source
	if sourceName == "" {
		sourceName = left.Source
	}
	merged := map[string]model.Row{}
	order := []string{}
	mergeRows := func(rows []model.Row) {
		for _, row := range rows {
			key := logicalRowKey(sourceName, row)
			if existing := merged[key]; existing != nil {
				combined := model.Row{}
				for field, value := range existing {
					combined[field] = value
				}
				for field, value := range row {
					if value != nil {
						combined[field] = value
					}
				}
				merged[key] = combined
				continue
			}
			copy := model.Row{}
			for field, value := range row {
				copy[field] = value
			}
			merged[key] = copy
			order = append(order, key)
		}
	}
	mergeRows(right.Rows)
	mergeRows(left.Rows)
	rows := make([]model.Row, 0, len(order))
	for _, key := range order {
		rows = append(rows, merged[key])
	}
	sort.SliceStable(rows, func(i, j int) bool {
		leftData, _ := json.Marshal(rows[i])
		rightData, _ := json.Marshal(rows[j])
		return bytes.Compare(leftData, rightData) < 0
	})
	metadata := model.Metadata{}
	for key, value := range left.Metadata {
		metadata[key] = value
	}
	for key, value := range right.Metadata {
		metadata[key] = value
	}
	return model.Source{Source: sourceName, Rows: rows, Metadata: metadata}
}

func logicalRowKey(sourceName string, row model.Row) string {
	fields := map[string][]string{
		"campaigns":    {"campaign"},
		"repositories": {"organization", "repository"},
		"workflows":    {"organization", "repository", "workflow"},
		"runs":         {"organization", "repository", "workflow", "run"},
		"domains":      {"event"},
		"tools":        {"event"},
		"audits":       {"event"},
		"issues":       {"event"},
		"outcomes":     {"safe-output"},
	}[sourceName]
	for _, fallback := range [][]string{fields, {"id"}} {
		if len(fallback) == 0 {
			continue
		}
		values := make([]string, 0, len(fallback))
		complete := true
		for _, field := range fallback {
			value := strings.TrimSpace(fmt.Sprint(row[field]))
			if value == "" || value == "<nil>" {
				complete = false
				break
			}
			values = append(values, value)
		}
		if complete {
			return sourceName + ":" + strings.Join(values, "\x00")
		}
	}
	data, _ := json.Marshal(row)
	return sourceName + ":json:" + string(data)
}

func buildDiagnostics(canonical map[string][]model.Row) model.Diagnostics {
	counts := map[string]int{}
	duplicates := map[string][]string{}
	for _, collection := range collections {
		counts[collection] = len(canonical[collection])
		seen := map[string]bool{}
		duplicateSet := map[string]bool{}
		for _, row := range canonical[collection] {
			id := strings.TrimSpace(fmt.Sprint(row["id"]))
			if id == "" || id == "<nil>" {
				continue
			}
			if seen[id] {
				duplicateSet[id] = true
			}
			seen[id] = true
		}
		duplicates[collection] = make([]string, 0, len(duplicateSet))
		for id := range duplicateSet {
			duplicates[collection] = append(duplicates[collection], id)
		}
		sort.Strings(duplicates[collection])
	}
	errors := relationshipErrors(canonical)
	return model.Diagnostics{
		SchemaVersion:      model.SchemaVersion,
		Counts:             counts,
		RelationshipErrors: errors,
		DuplicateRecordIDs: duplicates,
	}
}

func relationshipErrors(canonical map[string][]model.Row) []string {
	ids := map[string]map[string]bool{}
	records := map[string]map[string]model.Row{}
	for _, collection := range []string{"repositories", "campaigns", "workflows", "runs"} {
		ids[collection] = map[string]bool{}
		records[collection] = map[string]model.Row{}
		for _, row := range canonical[collection] {
			id := fmt.Sprint(row["id"])
			ids[collection][id] = true
			records[collection][id] = row
		}
	}
	var result []string
	require := func(row model.Row, field, collection, entity string) {
		id := fmt.Sprint(row["id"])
		reference := fmt.Sprint(row[field])
		if reference == "" || reference == "<nil>" || !ids[collection][reference] {
			result = append(result, fmt.Sprintf("%s.%s does not reference an existing %s", id, field, entity))
		}
	}
	for _, row := range canonical["workflows"] {
		require(row, "repositoryId", "repositories", "repository")
		if row["campaignId"] != nil {
			require(row, "campaignId", "campaigns", "campaign")
			if campaign := records["campaigns"][fmt.Sprint(row["campaignId"])]; campaign != nil &&
				fmt.Sprint(row["campaign"]) != fmt.Sprint(campaign["slug"]) {
				result = append(result, fmt.Sprintf("%s.campaignId references a different campaign slug", row["id"]))
			}
		}
	}
	for _, row := range canonical["runs"] {
		require(row, "repositoryId", "repositories", "repository")
		require(row, "workflowId", "workflows", "workflow")
		if workflow := records["workflows"][fmt.Sprint(row["workflowId"])]; workflow != nil &&
			fmt.Sprint(workflow["repositoryId"]) != fmt.Sprint(row["repositoryId"]) {
			result = append(result, fmt.Sprintf("%s.workflowId references a workflow from another repository", row["id"]))
		}
	}
	for _, collection := range []string{"domains", "tools", "audits", "issues"} {
		for _, row := range canonical[collection] {
			require(row, "runId", "runs", "run")
		}
	}
	sort.Strings(result)
	return result
}

func sortedSourceNames(sources map[string]model.Source) []string {
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func availability(rows []model.Row) string {
	if len(rows) == 0 {
		return "empty"
	}
	return "available"
}
