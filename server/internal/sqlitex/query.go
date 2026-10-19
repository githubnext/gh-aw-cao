package sqlitex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-aw-cao/internal/dashboardquery"

	"github.com/githubnext/gh-aw-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func (r *reader) ExecuteSQLPlan(ctx context.Context, definitions []query.Definition, requested []string) (map[string]model.Source, model.Metrics, error) {
	return r.ExecuteSQLPlanWithOptions(ctx, definitions, requested, dashboardstore.ExecutionOptions{})
}

func (r *reader) ExecuteSQLPlanWithOptions(ctx context.Context, definitions []query.Definition, requested []string, options dashboardstore.ExecutionOptions) (map[string]model.Source, model.Metrics, error) {
	metrics := model.Metrics{PushedDown: []string{}, FallbackOperations: []string{"local-go-plan"}}
	if options.ResourceLimits != nil {
		return nil, metrics, errors.New("local SQLite queries do not support overriding resource limits")
	}
	if err := query.Validate(definitions); err != nil {
		return nil, metrics, err
	}
	order, err := query.Dependencies(definitions, requested)
	if err != nil {
		return nil, metrics, err
	}
	if len(order) > query.MaxPlanQueries {
		return nil, metrics, errors.New("local query exceeds max plan queries")
	}
	state, err := r.State(ctx)
	if err != nil {
		return nil, metrics, err
	}
	index := map[string]query.Definition{}
	for _, definition := range definitions {
		index[definition.Name] = definition
	}
	roots := map[string]model.Metadata{}
	cache := map[string][]map[string]any{}
	evaluator := dashboardquery.NewEvaluator(ctx)
	retain := func(name string, rows []map[string]any) error {
		owned := make([]model.Row, len(rows))
		for index, row := range rows {
			owned[index] = model.Row(row)
		}
		bytes := query.EstimateRowsBytes(owned)
		metrics.PeakWorkingRows = max(metrics.PeakWorkingRows, len(rows))
		metrics.PeakWorkingBytes = max(metrics.PeakWorkingBytes, bytes)
		metrics.RetainedRows += len(rows)
		metrics.RetainedBytes += bytes
		metrics.Operations = int(evaluator.Operations())
		if len(rows) > query.MaxInputRows || bytes > query.MaxWorkingBytes {
			return fmt.Errorf("local query %q exceeds working input budget", name)
		}
		if metrics.RetainedRows > query.MaxRetainedRows || metrics.RetainedBytes > query.MaxRetainedBytes {
			return &query.PlanLimitError{QueryID: name, Boundary: query.BoundaryRetainedBytes}
		}
		cache[name] = rows
		return nil
	}
	loadRoot := func(name string) error {
		if _, exists := cache[name]; exists {
			return nil
		}
		source, err := r.source(ctx, name, state, options)
		if err != nil {
			return err
		}
		roots[name] = source.Metadata
		rows := make([]map[string]any, len(source.Rows))
		for index, row := range source.Rows {
			rows[index] = map[string]any(row)
		}
		return retain(name, rows)
	}
	for _, name := range order {
		if err := ctx.Err(); err != nil {
			return nil, metrics, err
		}
		definition, derived := index[name]
		if !derived {
			if err := loadRoot(name); err != nil {
				return nil, metrics, err
			}
			continue
		}
		inputs := append([]string{definition.From}, definition.Union...)
		for _, join := range definition.Joins {
			inputs = append(inputs, join.Source)
		}
		for _, input := range inputs {
			if _, derived := index[input]; !derived {
				if err := loadRoot(input); err != nil {
					return nil, metrics, err
				}
			}
		}
		content, err := json.Marshal(definition)
		if err != nil {
			return nil, metrics, err
		}
		var plan map[string]any
		if err := json.Unmarshal(content, &plan); err != nil {
			return nil, metrics, err
		}
		rows, err := evaluator.Execute(plan, func(input string) ([]map[string]any, error) {
			rows, exists := cache[input]
			if !exists {
				return nil, fmt.Errorf("local query input %q is unavailable", input)
			}
			return rows, nil
		})
		if err != nil {
			return nil, metrics, err
		}
		metrics.QueryCount++
		if err := retain(name, rows); err != nil {
			return nil, metrics, err
		}
	}
	output := make(map[string]model.Source, len(requested))
	for _, name := range requested {
		rows := cache[name]
		total := len(rows)
		metadata := postgresx.ComposeMetadata(definitions, roots, name)
		owned := model.Metadata{}
		for key, value := range metadata {
			owned[key] = value
		}
		metadata = owned
		if metadata["availability"] == "unavailable" {
			rows, total = nil, 0
		}
		page, paginated := options.Pages[name]
		if paginated {
			if page.Offset < 0 || page.Offset > total || page.Limit <= 0 || page.Limit > query.MaxOutputRows {
				return nil, metrics, fmt.Errorf("invalid or stale page for %q", name)
			}
			rows = rows[page.Offset:min(page.Offset+page.Limit, total)]
			metadata["total-row-count"] = total
		} else if total > query.MaxOutputRows {
			return nil, metrics, fmt.Errorf("query %q exceeds max output rows", name)
		}
		result := make([]model.Row, len(rows))
		for index, row := range rows {
			result[index] = model.Row(row)
		}
		metadata["source-id"], metadata["source-kind"], metadata["row-count"] = name, "derived", len(result)
		if metadata["availability"] != "unavailable" {
			metadata["availability"] = "available"
			if total == 0 {
				metadata["availability"] = "empty"
			}
		}
		output[name] = model.Source{Source: name, Rows: result, Metadata: metadata}
		metrics.OutputRows += len(result)
	}
	return output, metrics, nil
}

func (r *reader) source(ctx context.Context, name string, state dashboardstore.State, options dashboardstore.ExecutionOptions) (model.Source, error) {
	collection := strings.TrimPrefix(name, "$")
	if strings.HasPrefix(name, "$") && canonicalCollection(collection) {
		if _, declared := state.Counts[name]; !declared {
			return model.Source{}, fmt.Errorf("canonical SQLite source %q is not present in the snapshot", name)
		}
		rows, err := dashboardquery.ReadCollection(ctx, r.tx, collection, query.MaxInputRows, query.MaxWorkingBytes)
		if err != nil {
			return model.Source{}, err
		}
		result := make([]model.Row, len(rows))
		for index, row := range rows {
			result[index] = model.Row(row)
		}
		availability := "available"
		if len(result) == 0 {
			availability = "empty"
		}
		return model.Source{Source: name, Rows: result, Metadata: model.Metadata{
			"source-id": name, "availability": availability, "completeness": "unknown", "freshness": "unknown",
			"as-of": state.EvaluatedAt.Format("2006-01-02T15:04:05.999999999Z07:00"),
		}}, nil
	}
	switch name {
	case "collection-health", "github-quota-usage", "simulation-days", "$marketplacePackages",
		"cli-commands", "cli-command-summary", "cli-command-statuses":
		if options.Runtime != nil {
			return options.Runtime(ctx, name)
		}
	}
	return model.Source{}, fmt.Errorf("local query source %q is not registered", name)
}
