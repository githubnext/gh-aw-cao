package sqlitex

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/dashboard/queryengine"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
)

func (r *readTransaction) ExecuteSQLPlan(ctx context.Context, definitions []query.Definition, requested []string) (map[string]model.Source, model.Metrics, error) {
	return r.ExecuteSQLPlanWithOptions(ctx, definitions, requested, postgresx.SQLExecutionOptions{})
}

func (r *readTransaction) ExecuteSQLPlanWithOptions(ctx context.Context, definitions []query.Definition, requested []string, options postgresx.SQLExecutionOptions) (map[string]model.Source, model.Metrics, error) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	metrics := model.Metrics{PushedDown: []string{}, FallbackOperations: []string{"native-go"}}
	limits := postgresx.SQLResourceLimits{MaxInputRows: query.MaxInputRows, MaxOperations: query.MaxOperations, MaxWorkingBytes: query.MaxWorkingBytes}
	if options.ResourceLimits != nil {
		limits = *options.ResourceLimits
		if limits.MaxInputRows <= 0 || limits.MaxInputRows > query.MaxWorkingRows ||
			limits.MaxOperations <= 0 || limits.MaxOperations > 10*query.MaxOperations ||
			limits.MaxWorkingBytes <= 0 || limits.MaxWorkingBytes > 4*query.MaxWorkingBytes {
			return nil, metrics, errors.New("invalid local query resource limits")
		}
	}
	if len(definitions) > 2048 || len(requested) > 100 {
		return nil, metrics, errors.New("local query batch exceeds structural resource limits")
	}
	index := make(map[string]query.Definition, len(definitions))
	compiled := make(map[string]map[string]any, len(definitions))
	for _, definition := range definitions {
		if definition.Name == "" || definition.From == "" || len(definition.Name) > 200 {
			return nil, metrics, errors.New("query name and from are required")
		}
		if _, exists := index[definition.Name]; exists {
			return nil, metrics, fmt.Errorf("query name %q is declared more than once", definition.Name)
		}
		content, err := json.Marshal(definition)
		if err != nil {
			return nil, metrics, err
		}
		var native map[string]any
		if err := decode(string(content), &native); err != nil {
			return nil, metrics, err
		}
		if err := queryengine.Validate(native); err != nil {
			return nil, metrics, fmt.Errorf("query %q: %w", definition.Name, err)
		}
		index[definition.Name], compiled[definition.Name] = definition, native
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var preflight func(string, int, int) error
	preflight = func(name string, depth, joins int) error {
		if len(name) == 0 || len(name) > 200 {
			return errors.New("invalid local query source name")
		}
		if visiting[name] {
			return fmt.Errorf("query dependency cycle at %q", name)
		}
		// Resolved dependencies are materialized once and no longer occupy
		// the active execution path when another branch reuses them.
		if visited[name] {
			return nil
		}
		visiting[name] = true
		defer delete(visiting, name)
		if definition, exists := index[name]; exists {
			depth++
			joins += len(definition.Joins)
			if depth > query.MaxDependencyDepth || joins > query.MaxDependencyJoins {
				return errors.New("query dependency graph exceeds depth or join limits")
			}
			metrics.DependencyDepth = max(metrics.DependencyDepth, depth)
			for _, input := range inputs(definition) {
				if err := preflight(input, depth, joins); err != nil {
					return err
				}
			}
			metrics.QueryCount++
			if metrics.QueryCount > query.MaxPlanQueries {
				return errors.New("query dependency graph exceeds max plan queries")
			}
		}
		visited[name] = true
		return nil
	}
	for _, name := range requested {
		if err := preflight(name, 0, 0); err != nil {
			return nil, metrics, err
		}
	}
	for name, page := range options.Pages {
		if !slices.Contains(requested, name) || page.Offset < 0 || page.Limit < 1 || page.Limit > query.MaxOutputRows {
			return nil, metrics, errors.New("invalid local query pagination")
		}
	}
	cache := map[string]model.Source{}
	var cacheRows int
	var cacheBytes int64
	currentQuery := ""
	observe := func(_ string, rows []map[string]any) error {
		metrics.PeakWorkingRows = max(metrics.PeakWorkingRows, len(rows))
		size := query.EstimateRowsBytes(modelRows(rows))
		metrics.PeakWorkingBytes = max(metrics.PeakWorkingBytes, size)
		if len(rows) > limits.MaxInputRows || size > limits.MaxWorkingBytes {
			return &query.PlanLimitError{QueryID: currentQuery, Boundary: query.BoundaryRetainedBytes}
		}
		return ctx.Err()
	}
	session := queryengine.NewSession(ctx, queryengine.Options{
		MaxInputRows: limits.MaxInputRows, MaxOutputRows: limits.MaxInputRows,
		MaxOperations: limits.MaxOperations, Observe: observe,
	})
	var resolve func(string) (model.Source, error)
	resolve = func(name string) (model.Source, error) {
		if err := ctx.Err(); err != nil {
			return model.Source{}, err
		}
		if source, exists := cache[name]; exists {
			return source, nil
		}
		definition, derived := index[name]
		var source model.Source
		var err error
		if !derived {
			source, err = r.readSource(ctx, name, options.Runtime, limits)
		} else {
			resolved := map[string]model.Source{}
			for _, input := range inputs(definition) {
				value, err := resolve(input)
				if err != nil {
					return model.Source{}, err
				}
				resolved[input] = value
			}
			metadata := cloneMetadata(resolved[definition.From].Metadata)
			for _, input := range definition.Union {
				metadata = mergeMetadata(metadata, resolved[input].Metadata, false)
			}
			for _, join := range definition.Joins {
				metadata = mergeMetadata(metadata, resolved[join.Source].Metadata, join.Type == "left")
			}
			source = model.Source{Source: name, Metadata: metadata, Rows: []model.Row{}}
			if metadata["availability"] != "unavailable" {
				currentQuery = name
				var rows []map[string]any
				rows, err = session.Execute(compiled[name], func(input string) ([]map[string]any, error) {
					return nativeRows(resolved[input].Rows), nil
				})
				source.Rows = modelRows(rows)
			}
			recordMetrics(&metrics, definition)
			if definition.Stores != nil && metadata["availability"] != "unavailable" {
				source.Metadata = cloneMetadata(resolved[definition.From].Metadata)
				source.Metadata["source-kind"] = "database-query"
			} else {
				source.Metadata["source-kind"] = "derived"
				source.Metadata["query-name"] = name
				for _, field := range []string{"as-of", "retrieved-at"} {
					if value, _ := source.Metadata[field].(string); value == "" {
						source.Metadata[field] = "1970-01-01T00:00:00.000Z"
					}
				}
			}
			source.Metadata["source-id"] = name
		}
		if err != nil {
			return model.Source{}, err
		}
		if source.Rows == nil {
			source.Rows = []model.Row{}
		}
		currentQuery = name
		if err := observe("result", nativeRows(source.Rows)); err != nil {
			return model.Source{}, err
		}
		if source.Metadata == nil {
			source.Metadata = model.Metadata{}
		}
		if source.Metadata["availability"] == "unavailable" {
			source.Rows = []model.Row{}
		} else {
			source.Metadata["availability"] = "available"
			if len(source.Rows) == 0 {
				source.Metadata["availability"] = "empty"
			}
		}
		source.Metadata["row-count"] = len(source.Rows)
		cacheRows += len(source.Rows)
		cacheBytes += query.EstimateRowsBytes(source.Rows)
		if cacheRows > query.MaxRetainedRows || cacheBytes > query.MaxRetainedBytes {
			return model.Source{}, &query.PlanLimitError{QueryID: name, Boundary: query.BoundaryRetainedBytes}
		}
		cache[name] = source
		return source, nil
	}
	output := make(map[string]model.Source, len(requested))
	for _, name := range requested {
		source, err := resolve(name)
		metrics.Operations = int(session.Operations())
		if err != nil {
			return nil, metrics, err
		}
		total := len(source.Rows)
		page, paginated := options.Pages[name]
		if !paginated {
			if total > query.MaxOutputRows {
				return nil, metrics, fmt.Errorf("query %q exceeds max output rows", name)
			}
			page = postgresx.SQLPage{Limit: total}
		}
		if page.Offset > total {
			return nil, metrics, fmt.Errorf("invalid or stale continuation token for %q", name)
		}
		source.Rows = slices.Clone(source.Rows[page.Offset : page.Offset+min(page.Limit, total-page.Offset)])
		source.Metadata = cloneMetadata(source.Metadata)
		source.Metadata["row-count"] = len(source.Rows)
		if paginated {
			source.Metadata["total-row-count"] = total
		}
		metrics.OutputRows += len(source.Rows)
		metrics.RetainedRows += len(source.Rows)
		metrics.RetainedBytes += query.EstimateRowsBytes(source.Rows)
		if metrics.RetainedRows > query.MaxRetainedRows || metrics.RetainedBytes > query.MaxRetainedBytes {
			return nil, metrics, &query.PlanLimitError{QueryID: name, Boundary: query.BoundaryRetainedBytes}
		}
		output[name] = source
	}
	metrics.DurationMS = time.Since(started).Milliseconds()
	return output, metrics, nil
}

func inputs(definition query.Definition) []string {
	result := append([]string{definition.From}, definition.Union...)
	for _, join := range definition.Joins {
		result = append(result, join.Source)
	}
	return result
}

func modelRows(rows []map[string]any) []model.Row {
	result := make([]model.Row, len(rows))
	for i, row := range rows {
		result[i] = row
	}
	return result
}

func nativeRows(rows []model.Row) []map[string]any {
	result := make([]map[string]any, len(rows))
	for i, row := range rows {
		result[i] = row
	}
	return result
}

func (r *readTransaction) readSource(ctx context.Context, name string, runtime func(context.Context, string) (model.Source, error), limits postgresx.SQLResourceLimits) (model.Source, error) {
	switch name {
	case repositorymemory.ManifestSource, repositorymemory.FilesSource, "repository-memory-manifest", "repository-memory-files":
		if r.store.memoryAvailable {
			return r.memorySource(name)
		}
		if runtime != nil {
			source, err := runtime(ctx, name)
			source.Source = name
			return source, err
		}
		return r.memorySource(name)
	}
	if name == "simulation-days" {
		rows := []model.Row{}
		for day := 1; day <= 30; day++ {
			rows = append(rows, model.Row{"day": day, "date": fmt.Sprintf("2025-01-%02dT00:00:00.000Z", day)})
		}
		metadata := defaultMetadata(name)
		metadata["source-kind"], metadata["completeness"], metadata["freshness"] = "synthetic", "complete", "fresh"
		metadata["as-of"], metadata["retrieved-at"] = "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"
		return model.Source{Source: name, Rows: rows, Metadata: metadata}, nil
	}
	if !strings.HasPrefix(name, "$") {
		var source model.Source
		var err error
		switch name {
		case "cli-commands", "cli-command-statuses", "cli-command-summary", "collection-health", "github-quota-usage":
			if runtime == nil {
				return model.Source{}, fmt.Errorf("runtime source %q requires its authorized provider", name)
			}
			source, err = runtime(ctx, name)
		default:
			source, err = r.previewSource(ctx, name)
			if errors.Is(err, sql.ErrNoRows) && runtime != nil {
				source, err = runtime(ctx, name)
			}
		}
		if err != nil {
			return model.Source{}, fmt.Errorf("input source %q is unavailable: %w", name, err)
		}
		source.Source = name
		metadata := defaultMetadata(name)
		for key, value := range source.Metadata {
			metadata[key] = value
		}
		source.Metadata = metadata
		return source, nil
	}
	store := strings.TrimPrefix(name, "$")
	if !slices.Contains(collections, store) && store != "transactions" && store != "storageShards" {
		return model.Source{}, fmt.Errorf("unknown canonical collection %q", store)
	}
	registered := 1
	if r.store.tables["__idb_stores"] {
		if err := r.tx.QueryRowContext(ctx, `SELECT count(*) FROM __idb_stores WHERE database_name=? AND name=?`, r.store.database, store).Scan(&registered); err != nil {
			return model.Source{}, err
		}
		if registered != 1 && !r.store.native {
			return model.Source{}, fmt.Errorf("canonical collection %q is not registered", store)
		}
	}
	metadata := defaultMetadata(name)
	if r.store.native && (!r.state.Ready || registered != 1) {
		metadata["availability"] = "unavailable"
		metadata["error"] = "canonical collection is not available in this snapshot"
	}
	for _, alias := range canonicalAliases(store) {
		value, err := r.previewMetadata(ctx, alias)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return model.Source{}, err
		}
		unavailable := metadata["availability"] == "unavailable"
		for key, value := range value {
			metadata[key] = value
		}
		if unavailable {
			metadata["availability"] = "unavailable"
		}
	}
	// Older projections can store source quality separately from logical rows.
	// Explicit unavailability always wins over a physically populated store.
	for _, key := range []string{store, name} {
		var content string
		err := r.tx.QueryRowContext(ctx, `SELECT value FROM __idb_records WHERE database_name=? AND store_name='quality' AND record_key=?`,
			r.store.database, mustJSON(key)).Scan(&content)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return model.Source{}, err
		}
		var value map[string]any
		if err := decode(content, &value); err != nil {
			return model.Source{}, err
		}
		if value == nil {
			return model.Source{}, fmt.Errorf("invalid quality metadata for canonical collection %q", store)
		}
		if nested, ok := value["metadata"].(map[string]any); ok {
			value = nested
		}
		unavailable := metadata["availability"] == "unavailable"
		for key, value := range value {
			metadata[key] = value
		}
		if unavailable {
			metadata["availability"] = "unavailable"
		}
	}
	source := model.Source{Source: name, Rows: []model.Row{}, Metadata: metadata}
	if metadata["availability"] == "unavailable" {
		return source, nil
	}
	rows, err := r.tx.QueryContext(ctx, `SELECT record_key,value FROM __idb_records WHERE database_name=? AND store_name=? LIMIT ?`,
		r.store.database, store, limits.MaxInputRows+1)
	if err != nil {
		return model.Source{}, err
	}
	defer func() { _ = rows.Close() }()
	type keyedRow struct {
		key any
		row model.Row
	}
	entries := []keyedRow{}
	var bytes int64
	for rows.Next() {
		if len(entries) >= limits.MaxInputRows {
			return model.Source{}, fmt.Errorf("canonical collection %q exceeds max input rows", store)
		}
		var keyJSON, content string
		if err := rows.Scan(&keyJSON, &content); err != nil {
			return model.Source{}, err
		}
		var key any
		if json.Unmarshal([]byte(keyJSON), &key) != nil || !queryengine.ValidRecordKey(key) {
			return model.Source{}, fmt.Errorf("invalid canonical %s record key", store)
		}
		bytes += int64(len(content))
		if bytes > limits.MaxWorkingBytes {
			return model.Source{}, &query.PlanLimitError{QueryID: name, Boundary: query.BoundaryRetainedBytes}
		}
		var row model.Row
		if err := decode(content, &row); err != nil || row == nil {
			return model.Source{}, fmt.Errorf("invalid canonical record in %q", store)
		}
		// These are adapter-owned storage/index hints, not canonical evidence.
		if store != "transactions" {
			delete(row, "_storage")
			delete(row, "_queryKeys")
		}
		if store == "workflows" {
			r.store.applyCompilerOverrides(row)
		}
		entries = append(entries, keyedRow{key: key, row: row})
	}
	slices.SortFunc(entries, func(a, b keyedRow) int { return queryengine.CompareRecordKeys(a.key, b.key) })
	for _, entry := range entries {
		source.Rows = append(source.Rows, entry.row)
	}
	if err := rows.Err(); err != nil {
		return model.Source{}, err
	}
	source.Rows, err = r.store.enrichInventory(store, source.Rows)
	if err != nil {
		return model.Source{}, err
	}
	if len(source.Rows) > limits.MaxInputRows || query.EstimateRowsBytes(source.Rows) > limits.MaxWorkingBytes {
		return model.Source{}, &query.PlanLimitError{QueryID: name, Boundary: query.BoundaryRetainedBytes}
	}
	return source, nil
}

func (r *readTransaction) previewSource(ctx context.Context, name string) (model.Source, error) {
	if !r.store.tables["preview_sources"] {
		if source, present := r.store.inventory[name]; present {
			return source, nil
		}
		return model.Source{}, sql.ErrNoRows
	}
	var content string
	if err := r.tx.QueryRowContext(ctx, `SELECT value FROM preview_sources WHERE name=?`, name).Scan(&content); err != nil {
		return model.Source{}, err
	}

	var source model.Source
	if err := decode(content, &source); err != nil {
		return model.Source{}, fmt.Errorf("invalid preview source %q: %w", name, err)
	}
	return source, nil
}

func (r *readTransaction) previewMetadata(ctx context.Context, name string) (model.Metadata, error) {
	if !r.store.tables["preview_sources"] {
		source, err := r.previewSource(ctx, name)
		return source.Metadata, err
	}
	var content sql.NullString
	if err := r.tx.QueryRowContext(ctx, `SELECT json_extract(value,'$.metadata') FROM preview_sources WHERE name=?`, name).Scan(&content); err != nil {
		return nil, err
	}
	metadata := model.Metadata{}
	if content.Valid {
		if err := decode(content.String, &metadata); err != nil {
			return nil, err
		}
	}
	return metadata, nil
}

func canonicalAliases(store string) []string {
	switch store {
	case "operationalValues":
		return []string{store, "operational-values"}
	case "marketplacePackages":
		return []string{store, "marketplace-packages"}
	case "experimentAssignments":
		return []string{store, "experiment-assignments"}
	case "graderObservations":
		return []string{store, "grader-observations"}
	case "evalObservations":
		return []string{store, "eval-observations"}
	}
	return []string{store}
}

func mustJSON(value string) string {
	content, _ := json.Marshal(value)
	return string(content)
}

func defaultMetadata(name string) model.Metadata {
	return model.Metadata{
		"source-id": name, "source-kind": "canonical", "availability": "available",
		"completeness": "unknown", "freshness": "unknown", "as-of": "", "retrieved-at": "",
	}
}

func cloneMetadata(metadata model.Metadata) model.Metadata {
	result := model.Metadata{}
	for key, value := range metadata {
		result[key] = value
	}
	return result
}

func mergeMetadata(left, right model.Metadata, optional bool) model.Metadata {
	result := cloneMetadata(left)
	for _, field := range []string{"as-of", "retrieved-at"} {
		a, _ := left[field].(string)
		b, _ := right[field].(string)
		aTime, aValid := queryengine.ParseDate(a)
		bTime, bValid := queryengine.ParseDate(b)
		if bValid && (!aValid || bTime < aTime) {
			result[field] = b
		}
	}
	for _, field := range []string{"completeness", "freshness"} {
		a, b := left[field], right[field]
		weak := "partial"
		if field == "freshness" {
			weak = "stale"
		}
		if a == weak || b == weak {
			result[field] = weak
		} else if a == nil || b == nil || a == "unknown" || b == "unknown" || a == "" || b == "" {
			result[field] = "unknown"
		}
	}
	if right["availability"] == "unavailable" {
		if optional {
			result["completeness"] = "partial"
		} else {
			result["availability"] = "unavailable"
		}
	}
	return result
}

func recordMetrics(metrics *model.Metrics, definition query.Definition) {
	metrics.UnionCount += len(definition.Union)
	metrics.JoinCount += len(definition.Joins)
	metrics.ComputeCount += len(definition.Compute)
	metrics.SelectCount += len(definition.Select)
	metrics.OrderByCount += len(definition.OrderBy)
	if definition.Filter != nil {
		metrics.FilterCount++
	}
	if definition.Aggregate != nil {
		metrics.AggregateCount++
		metrics.AggregateValueCount += len(definition.Aggregate.Values)
	}
	if definition.TemporalSeries != nil {
		metrics.TemporalSeriesCount++
	}
	if definition.Limit != nil {
		metrics.LimitCount++
	}
}
