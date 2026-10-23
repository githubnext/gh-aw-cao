package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-cao/internal/dashboardquery"
	"github.com/githubnext/gh-cao/server/internal/logger"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

var statisticalLog = logger.New("cao:postgresx:sampling")

// Sampling reads compact metadata from the pinned transaction. Consumer filters
// compile only after this root has been frozen; SQL remains responsible for all
// evidence projection and joins.
func (r *readTransaction) statisticalSQLSource(ctx context.Context) (query.SQLRelation, model.Metadata, error) {
	quality, err := r.rootMetadata(ctx, "$runs")
	if err != nil {
		return query.SQLRelation{}, nil, err
	}
	var recorded sql.NullTime
	if err := r.tx.QueryRowContext(ctx, `SELECT as_of FROM cao_quality WHERE namespace=$1 AND collection='$runs'`,
		r.store.namespace).Scan(&recorded); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return query.SQLRelation{}, nil, err
	}
	relation, err := r.entitySQLSource("$runs")
	if err != nil {
		return query.SQLRelation{}, nil, err
	}
	fields := []string{"id", "owner", "repository", "githubRunId", "startedAt", "createdAt", "completedAt", "updatedAt", "status", "conclusion"}
	projections := make([]string, len(fields))
	for index, field := range fields {
		column, exists := relation.Columns[field]
		if !exists {
			return query.SQLRelation{}, nil, fmt.Errorf("statistical canonical field %q is missing", field)
		}
		projections[index] = column.Expression
	}
	statement := "SELECT " + strings.Join(projections, ",") + " FROM " +
		strings.ReplaceAll(relation.SQL, "{}", "$1") + fmt.Sprintf(" LIMIT %d", query.MaxInputRows+1)
	rows, err := r.tx.QueryContext(ctx, statement, r.store.namespace)
	if err != nil {
		return query.SQLRelation{}, nil, err
	}
	candidates, err := func() ([]map[string]any, error) {
		defer func() { _ = rows.Close() }()
		result := []map[string]any{}
		var bytes int64
		for rows.Next() {
			if len(result) >= query.MaxInputRows {
				return nil, dashboardquery.ErrStatisticalBudget
			}
			values := make([]any, len(fields))
			dest := make([]any, len(fields))
			for index := range dest {
				dest[index] = &values[index]
			}
			if err := rows.Scan(dest...); err != nil {
				return nil, err
			}
			row := map[string]any{}
			for index, field := range fields {
				value, err := decodeSQLValue(values[index], relation.Columns[field].Kind)
				if err != nil {
					return nil, err
				}
				row[field] = value
			}
			bytes += query.EstimateRowsBytes([]model.Row{model.Row(row)})
			if bytes > query.MaxWorkingBytes {
				return nil, dashboardquery.ErrStatisticalBudget
			}
			result = append(result, row)
		}
		return result, rows.Err()
	}()
	if err != nil && !errors.Is(err, dashboardquery.ErrStatisticalBudget) {
		return query.SQLRelation{}, nil, err
	}
	watermark, policy := dashboardquery.CanonicalStatisticalWatermark(candidates), "canonical-run-max"
	if recorded.Valid {
		watermark, policy = recorded.Time.UTC().Format("2006-01-02T15:04:05.000Z"), "recorded-run-as-of"
	}
	var selected []map[string]any
	frame := map[string]any{"weight-valid": false}
	if errors.Is(err, dashboardquery.ErrStatisticalBudget) {
		statisticalLog.Print("event=statistical-source status=unavailable reason=input-budget")
		quality["availability"] = "unavailable"
		quality["completeness"] = "unknown"
		quality["error"] = "statistical candidate frame exceeds input budget"
	} else if watermark == "" {
		statisticalLog.Print("event=statistical-source status=unavailable reason=missing-clock")
		quality["availability"] = "unavailable"
		quality["completeness"] = "unknown"
		quality["error"] = "statistical sampling requires a recorded canonical watermark"
	} else {
		selected, frame, err = dashboardquery.SampleStatisticalRuns(candidates, dashboardquery.StatisticalOptions{
			Context: ctx, Logf: statisticalLog.Printf,
			Watermark: watermark, Capacity: dashboardquery.StatisticalPostgresCapacity,
			Complete: quality["completeness"] == "complete" && quality["availability"] != "unavailable",
		})
		if err != nil {
			if !errors.Is(err, dashboardquery.ErrStatisticalBudget) {
				return query.SQLRelation{}, nil, err
			}
			frame = map[string]any{"weight-valid": false}
			quality["availability"] = "unavailable"
			quality["completeness"] = "unknown"
			quality["error"] = "statistical candidate frame exceeds input budget"
		}
	}
	frame["watermark-policy"] = policy
	quality["as-of"] = watermark
	quality["statistical-frame"] = frame
	quality["source-id"] = "$statisticalMembership"
	members := dashboardquery.StatisticalMembership(selected)
	payload, err := json.Marshal(members)
	if err != nil {
		return query.SQLRelation{}, nil, err
	}
	names := []string{"id", "organization", "repository", "run", "statistical-frame-id", "statistical-stratum", "statistical-priority",
		"statistical-population", "statistical-allocation", "statistical-weight-valid", "statistical-probability", "statistical-weight"}
	columns := map[string]query.SQLColumn{}
	declarations := make([]string, len(names))
	for index, name := range names {
		kind, sqlType := query.SQLText, "text"
		switch name {
		case "statistical-population", "statistical-allocation", "statistical-probability", "statistical-weight":
			kind, sqlType = query.SQLNumber, "numeric"
		case "statistical-weight-valid":
			kind, sqlType = query.SQLBoolean, "boolean"
		}
		identifier := query.SQLIdentifier(name)
		declarations[index] = identifier + " " + sqlType
		columns[name] = query.SQLColumn{Expression: "t." + identifier, Presence: "t." + identifier + " IS NOT NULL", Kind: kind}
	}
	return query.SQLRelation{
		SQL: "(SELECT m.*, row_number() OVER () AS ordinal FROM jsonb_to_recordset({}::jsonb) AS m(" +
			strings.Join(declarations, ",") + ")) AS t",
		Params: []any{string(payload)}, Columns: columns, Order: "t.ordinal",
	}, quality, nil
}
