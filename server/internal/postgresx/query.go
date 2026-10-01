package postgresx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

var ErrUnsupportedPlan = errors.New("Dashboard Language plan is not supported by the PostgreSQL executor")

const sourceQuerySQL = `
	SELECT raw
	FROM cao_projection_rows
	WHERE snapshot_id = $1 AND source_name = $2
	ORDER BY ordinal
	LIMIT $3`

type SQLPlan struct {
	SQL  string
	Args []any
}

func Compile(definition query.Definition, snapshotID string) (SQLPlan, error) {
	plan := query.Normalize(definition)
	if definition.Name == "" || definition.From == "" || plan.ResultShape.Mode != query.PreserveInput ||
		len(plan.Stages) != 1 || plan.Stages[0].Operator != "from" ||
		len(definition.Union) != 0 || len(definition.Joins) != 0 ||
		definition.Filter != nil || len(definition.Compute) != 0 ||
		definition.Aggregate != nil || definition.TemporalSeries != nil ||
		len(definition.Predict) != 0 || len(definition.Select) != 0 ||
		len(definition.OrderBy) != 0 || definition.Limit != nil ||
		len(definition.Stores) != 0 || len(definition.StoresBySource) != 0 {
		return SQLPlan{}, ErrUnsupportedPlan
	}
	return SQLPlan{
		SQL:  sourceQuerySQL,
		Args: []any{snapshotID, definition.From, query.MaxInputRows + 1},
	}, nil
}

func (store *Store) ExecutePlan(
	ctx context.Context,
	snapshotID string,
	definitions []query.Definition,
	requested, _ []string,
	external map[string]model.Source,
) (map[string]model.Source, model.Metrics, error) {
	if len(external) != 0 || len(definitions) != 1 || len(requested) != 1 ||
		requested[0] != definitions[0].Name {
		return nil, model.Metrics{}, ErrUnsupportedPlan
	}
	definition := definitions[0]
	plan, err := Compile(definition, snapshotID)
	if err != nil {
		return nil, model.Metrics{}, err
	}
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	started := time.Now()
	rows, err := store.pool.Query(ctx, plan.SQL, plan.Args...)
	if err != nil {
		return nil, model.Metrics{}, errors.New("execute PostgreSQL dashboard query")
	}
	defer rows.Close()
	result := model.Source{Source: definition.Name, Rows: []model.Row{}, Metadata: model.Metadata{}}
	if err := store.pool.QueryRow(ctx, `
		SELECT metadata FROM cao_projection_sources
		WHERE snapshot_id = $1 AND source_name = $2`,
		snapshotID, definition.From).Scan(&result.Metadata); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, model.Metrics{}, fmt.Errorf("PostgreSQL source %q is unavailable", definition.From)
		}
		return nil, model.Metrics{}, errors.New("read PostgreSQL dashboard source metadata")
	}
	if result.Metadata == nil {
		result.Metadata = model.Metadata{}
	}
	for rows.Next() {
		var raw []byte
		var row model.Row
		if err := rows.Scan(&raw); err != nil {
			return nil, model.Metrics{}, errors.New("decode PostgreSQL dashboard row")
		}
		if err := json.Unmarshal(raw, &row); err != nil {
			return nil, model.Metrics{}, errors.New("decode PostgreSQL dashboard row")
		}
		result.Rows = append(result.Rows, row)
		if len(result.Rows) > query.MaxInputRows {
			return nil, model.Metrics{}, errors.New("PostgreSQL query exceeds max input rows")
		}
	}
	if err := rows.Err(); err != nil {
		return nil, model.Metrics{}, errors.New("read PostgreSQL dashboard rows")
	}
	result.Metadata["source-id"] = definition.Name
	result.Metadata["source-kind"] = "database-query"
	result.Metadata["row-count"] = len(result.Rows)
	availability := "available"
	if len(result.Rows) == 0 {
		availability = "empty"
	}
	result.Metadata["availability"] = availability
	metrics := model.Metrics{
		DurationMS: time.Since(started).Milliseconds(),
		QueryCount: 1, OutputRows: len(result.Rows),
		PushedDown: []string{"postgres"},
	}
	return map[string]model.Source{definition.Name: result}, metrics, nil
}
