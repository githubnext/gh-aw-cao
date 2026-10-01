package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// NativePlanExecutor executes supported complete query paths within the same
// repeatable-read snapshot as State. A false result leaves the Go evaluator in
// charge; a database or resource error must never silently switch evaluators.
type NativePlanExecutor interface {
	ExecuteNativePlan(context.Context, []query.Definition, []string, []string) (map[string]model.Source, model.Metrics, bool, error)
}

// simplePlan admits a raw source followed by one or two definitions. The first
// may be a passthrough alias; only the final definition may filter or select.
// In particular, it never treats an unsupported operator as a residual after
// applying LIMIT or filtering, which would change its input and cost bounds.
func simplePlan(definitions []query.Definition, requested, order []string) (string, []query.Definition, bool) {
	if len(requested) != 1 || len(order) < 1 || len(order) > 2 || order[len(order)-1] != requested[0] {
		return "", nil, false
	}
	index := make(map[string]query.Definition, len(definitions))
	for _, definition := range definitions {
		index[definition.Name] = definition
	}
	raw := index[order[0]].From
	if _, derived := index[raw]; derived {
		return "", nil, false
	}
	path := make([]query.Definition, 0, len(order))
	for i, name := range order {
		definition, ok := index[name]
		from := raw
		if i != 0 {
			from = order[i-1]
		}
		if !ok || definition.From != from ||
			len(definition.Union) != 0 || len(definition.Joins) != 0 ||
			len(definition.Compute) != 0 || definition.Aggregate != nil ||
			definition.TemporalSeries != nil || len(definition.Predict) != 0 ||
			len(definition.OrderBy) != 0 {
			return "", nil, false
		}
		if i < len(order)-1 && (definition.Filter != nil || len(definition.Select) != 0 || definition.Limit != nil) {
			return "", nil, false
		}
		if definition.Filter != nil {
			if definition.Filter.Search != nil {
				return "", nil, false
			}
			seenFields := map[string]bool{}
			for _, predicate := range definition.Filter.Predicates {
				value, stringValue := predicate.Equals.(string)
				_, isBoolean := predicate.Equals.(bool)
				switch predicate.Field {
				case "id", "runId", "sessionId":
					if !stringValue {
						return "", nil, false
					}
				default:
					if !isCanonicalSource(raw) ||
						!(isCanonicalTextField(predicate.Field) && stringValue ||
							isCanonicalBoolean(predicate.Field) && isBoolean ||
							isCanonicalNumber(predicate.Field) && (stringValue || isQueryNumber(predicate.Equals))) {
						return "", nil, false
					}
				}

				if seenFields[predicate.Field] || (stringValue && value == "unknown") || predicate.Optional ||
					len(predicate.In) != 0 || predicate.Includes != "" ||
					predicate.GTE != nil || predicate.LT != nil {
					return "", nil, false
				}
				seenFields[predicate.Field] = true
			}
		}
		path = append(path, definition)
	}
	return raw, path, true
}

func isQueryNumber(value any) bool {
	switch value.(type) {
	case int, int64, float64, json.Number:
		return true
	default:
		return false
	}
}

func (r *readTransaction) ExecuteNativePlan(ctx context.Context, definitions []query.Definition, requested, order []string) (map[string]model.Source, model.Metrics, bool, error) {
	raw, path, supported := simplePlan(definitions, requested, order)
	if !supported {
		return nil, model.Metrics{}, false, nil
	}
	var baseBytes sql.NullInt64
	var metadataText sql.NullString
	var baseCount int
	var canonical bool
	err := r.tx.QueryRowContext(ctx, `SELECT c.count, s.estimated_bytes, d.payload, s.is_canonical
		FROM cao_sources AS s
		JOIN cao_counts AS c ON c.namespace = s.namespace AND c.source_name = s.source_name
		LEFT JOIN cao_source_documents AS d ON d.namespace = s.namespace AND d.source_name = s.source_name
			AND d.ordinal = -1 AND NOT s.is_canonical
		WHERE s.namespace = $1 AND s.source_name = $2`, r.store.namespace, raw).
		Scan(&baseCount, &baseBytes, &metadataText, &canonical)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, model.Metrics{}, false, nil
	}
	if err != nil {
		return nil, model.Metrics{}, true, fmt.Errorf("read postgres plan input: %w", err)
	}
	if !baseBytes.Valid {
		return nil, model.Metrics{}, true, errors.New("incomplete postgres source")
	}
	var metadata model.Metadata
	if canonical {
		metadata, err = readCanonicalMetadata(ctx, r.tx, r.store.namespace, raw)
	} else if isCanonicalSource(raw) || !metadataText.Valid {
		return nil, model.Metrics{}, true, errors.New("incomplete postgres source metadata")
	} else {
		err = decodeJSON([]byte(metadataText.String), &metadata)
	}
	if err != nil {
		return nil, model.Metrics{}, true, fmt.Errorf("invalid postgres source metadata: %w", err)
	}
	if metadata["availability"] == "unavailable" || baseCount < 0 || baseBytes.Int64 < 0 {
		return nil, model.Metrics{}, false, nil
	}
	if baseCount > query.MaxInputRows {
		return nil, model.Metrics{}, true, fmt.Errorf("query %q exceeds max input rows", path[0].Name)
	}
	if baseBytes.Int64 > query.MaxWorkingBytes {
		return nil, model.Metrics{}, true, fmt.Errorf("query %q exceeds max working bytes of %d", path[0].Name, query.MaxWorkingBytes)
	}
	var canonicalCount int
	if isCanonicalSource(raw) {
		if err := r.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
			WHERE namespace = $1 AND source_name = $2`, r.store.namespace, raw).Scan(&canonicalCount); err != nil {
			return nil, model.Metrics{}, true, err
		}
	}
	if (canonical && canonicalCount != baseCount) || (!canonical && canonicalCount != 0) {
		return nil, model.Metrics{}, true, errors.New("incomplete postgres canonical source")
	}
	if !canonical {
		for _, definition := range path {
			if definition.Filter == nil {
				continue
			}
			for _, predicate := range definition.Filter.Predicates {
				switch predicate.Field {
				case "id", "runId", "sessionId":
				default:
					// Legacy documents cannot promise the typed text semantics.
					return nil, model.Metrics{}, false, nil
				}
			}
		}
	}

	metrics := model.Metrics{
		PushedDown: []string{"query-plan"}, FallbackOperations: []string{},
		PeakWorkingRows: baseCount, PeakWorkingBytes: baseBytes.Int64,
	}
	currentCount := baseCount
	currentBytes := baseBytes.Int64
	var output []model.Row
	for i, definition := range path {
		inputCount := currentCount
		if inputCount > query.MaxInputRows {
			return nil, metrics, true, fmt.Errorf("query %q exceeds max input rows", definition.Name)
		}
		metrics.Operations += inputCount // FROM is charged even for rows rejected by a later filter.
		metrics.QueryCount++
		metrics.PushedDown = append(metrics.PushedDown, "from")
		var where string
		var args []any
		if !canonical {
			where, args = documentFilter(r.store.namespace, raw, definition.Filter)
		}
		filters := map[string]any{}
		if definition.Filter != nil {
			for _, predicate := range definition.Filter.Predicates {
				filters[predicate.Field] = predicate.Equals
			}
		}
		if definition.Filter != nil {
			metrics.FilterCount++
			metrics.Operations += inputCount
			metrics.PushedDown = append(metrics.PushedDown, "filter")
			if len(definition.Filter.Predicates) != 0 {
				var err error
				if canonical {
					canonicalWhere, canonicalArgs := canonicalFilter(r.store.namespace, raw, filters)
					err = r.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows WHERE `+canonicalWhere,
						canonicalArgs...).Scan(&currentCount)
				} else {
					var id, runID, sessionID any
					if value, ok := filters["id"]; ok {
						id = value
					}
					if value, ok := filters["runId"]; ok {
						runID = value
					}
					if value, ok := filters["sessionId"]; ok {
						sessionID = value
					}
					err = r.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_documents
						WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0
							AND ($3::text IS NULL OR id = $3)
							AND ($4::text IS NULL OR run_id = $4)
							AND ($5::text IS NULL OR session_id = $5)`,
						r.store.namespace, raw, id, runID, sessionID).Scan(&currentCount)
				}
				if err != nil {
					return nil, metrics, true, fmt.Errorf("count postgres plan rows: %w", err)
				}
			}
			metrics.Operations += currentCount // residual FROM after safe pre-filtering
		}
		if len(definition.Select) != 0 {
			metrics.SelectCount += len(definition.Select)
			metrics.Operations += currentCount
			metrics.PushedDown = append(metrics.PushedDown, "select")
		}
		if definition.Limit != nil {
			metrics.LimitCount++
			metrics.PushedDown = append(metrics.PushedDown, "limit")
			currentCount = min(currentCount, *definition.Limit)
		}
		if currentCount > query.MaxOutputRows {
			return nil, metrics, true, fmt.Errorf("query %q exceeds max output rows", definition.Name)
		}
		if metrics.Operations > query.MaxOperations {
			return nil, metrics, true, fmt.Errorf("query %q exceeds max operations", definition.Name)
		}
		if i == len(path)-1 {
			if canonical {
				output, err = r.canonicalPlanRows(ctx, raw, filters, definition.Select, currentCount,
					query.MaxRetainedBytes-metrics.RetainedBytes, definition.Name)
			} else {
				output, err = r.documentRows(ctx, where, args, definition.Select, currentCount,
					query.MaxRetainedBytes-metrics.RetainedBytes, definition.Name)
			}
			if err != nil {
				return nil, metrics, true, err
			}
			currentBytes = query.EstimateRowsBytes(output)
		}
		metrics.RetainedRows += currentCount
		metrics.RetainedBytes += currentBytes
		if metrics.RetainedRows > query.MaxRetainedRows {
			return nil, metrics, true, fmt.Errorf("query plan exceeds max retained rows of %d", query.MaxRetainedRows)
		}
		if metrics.RetainedBytes > query.MaxRetainedBytes {
			return nil, metrics, true, &query.PlanLimitError{QueryID: definition.Name, Boundary: query.BoundaryRetainedBytes}
		}
		if i < len(path)-1 {
			metadata = queryMetadata(metadata, definition.Name, currentCount)
		}
	}
	name := requested[0]
	result := model.Source{Source: name, Rows: output, Metadata: queryMetadata(metadata, name, len(output))}
	metrics.OutputRows = len(output)
	return map[string]model.Source{name: result}, metrics, true, nil
}

func queryMetadata(base model.Metadata, name string, count int) model.Metadata {
	metadata := make(model.Metadata, len(base)+4)
	for key, value := range base {
		metadata[key] = value
	}
	metadata["source-id"] = name
	metadata["source-kind"] = "database-query"
	metadata["row-count"] = count
	if count == 0 {
		metadata["availability"] = "empty"
	} else {
		metadata["availability"] = "available"
	}
	return metadata
}

func documentFilter(namespace, name string, filter *query.Filter) (string, []any) {
	args := []any{namespace, name}
	where := `namespace = {} AND source_name = {} AND ordinal >= 0`
	if filter != nil {
		for _, predicate := range filter.Predicates {
			// This map is a fixed field whitelist, never a client SQL identifier.
			column := map[string]string{"id": "id", "runId": "run_id", "sessionId": "session_id"}[predicate.Field]
			args = append(args, sqlIdentifier(column), predicate.Equals)
			where += " AND {} = {}"
		}
	}
	return where, args
}

func (r *readTransaction) documentRows(ctx context.Context, where string, args []any, selectFields []query.SelectedField,
	count int, remainingBytes int64, queryID string) ([]model.Row, error) {
	var statement strings.Builder
	values := make([]any, 0, len(selectFields)+len(args)+1)
	statement.WriteString("SELECT ")
	if len(selectFields) == 0 {
		statement.WriteString("payload")
	} else {
		for i, field := range selectFields {
			if i != 0 {
				statement.WriteByte(',')
			}
			values = append(values, field.Field)
			statement.WriteString("json_extract_path(payload::json, {})::text")
		}
	}
	statement.WriteString(" FROM cao_source_documents WHERE ")
	statement.WriteString(where)
	statement.WriteString(" ORDER BY ordinal LIMIT {}")
	values = append(values, args...)
	values = append(values, count+1)
	text, bound, err := postgresSQL(statement.String(), values...)
	if err != nil {
		return nil, fmt.Errorf("compile postgres plan rows: %w", err)
	}
	rows, err := r.tx.QueryContext(ctx, text, bound...)
	if err != nil {
		return nil, fmt.Errorf("read postgres plan rows: %w", err)
	}
	defer func() { _ = rows.Close() }()
	columnCount := max(1, len(selectFields))
	output := make([]model.Row, 0, min(count, query.MaxOutputRows))
	var retainedBytes int64
	for rows.Next() {
		if len(output) >= count {
			return nil, errors.New("postgres plan row count changed")
		}
		values := make([]sql.NullString, columnCount)
		dest := make([]any, columnCount)
		for i := range dest {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("scan postgres plan rows: %w", err)
		}
		row := model.Row{}
		if len(selectFields) == 0 {
			if err := decodeJSON([]byte(values[0].String), &row); err != nil || row == nil {
				return nil, errors.New("invalid postgres plan row")
			}
		} else {
			for i, field := range selectFields {
				if !values[i].Valid {
					continue
				}
				var value any
				if err := decodeJSON([]byte(values[i].String), &value); err != nil {
					return nil, errors.New("invalid postgres plan field")
				}
				alias := field.Field
				if field.As != "" {
					alias = field.As
				}
				row[alias] = value
			}
		}
		retainedBytes += query.EstimateRowsBytes([]model.Row{row})
		if retainedBytes > remainingBytes {
			return nil, &query.PlanLimitError{QueryID: queryID, Boundary: query.BoundaryRetainedBytes}
		}
		output = append(output, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read postgres plan rows: %w", err)
	}
	if len(output) != count {
		return nil, errors.New("postgres plan row count changed")
	}
	return output, nil
}
