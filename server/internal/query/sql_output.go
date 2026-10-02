package query

import (
	"errors"
	"fmt"
	"strings"
)

// OutputStatement returns typed values and presence flags for bounded wire
// serialization. It does not construct a JSON document for every source row.
func (plan SQLPlan) OutputStatement(name string, offset, limit int) (string, []any, []string, error) {
	relation, exists := plan.Outputs[name]
	if !exists || relation.SQL == "" {
		return "", nil, nil, errors.New("SQL output is not declared")
	}
	if offset < 0 || limit <= 0 || limit > MaxOutputRows {
		return "", nil, nil, errors.New("invalid SQL output page")
	}
	fields := sortedSQLFields(relation.Columns)
	projection := make([]string, 0, max(1, len(fields)*2))
	for index, field := range fields {
		column := relation.Columns[field]
		projection = append(projection, column.Expression+" AS "+SQLIdentifier(field),
			"("+column.Presence+") IS TRUE AS "+SQLIdentifier(fmt.Sprintf("__present_%d", index)))
	}
	if len(projection) == 0 {
		projection = append(projection, "TRUE AS __empty_projection")
	}
	args := append([]any{}, plan.Args...)
	args = append(args, limit, offset)
	statement := plan.CTEs + "\nSELECT " + strings.Join(projection, ",") + " FROM " + relation.SQL +
		" ORDER BY " + relation.Order + fmt.Sprintf(" LIMIT $%d OFFSET $%d", len(args)-1, len(args))
	return statement, args, fields, nil
}

// StatisticsStatement performs cardinality and byte accounting in Postgres,
// without fetching or reconstructing collections in Go.
func (plan SQLPlan) StatisticsStatement() (string, []any) {
	seen := map[string]bool{}
	var branches []string
	args := append([]any{}, plan.Args...)
	for _, step := range plan.Steps {
		if seen[step.Relation] {
			continue
		}
		seen[step.Relation] = true
		args = append(args, step.Relation)
		branches = append(branches, fmt.Sprintf("SELECT $%d::text AS relation, count(*) AS rows, coalesce(sum(pg_column_size(r)),0) AS bytes FROM %s AS r",
			len(args), SQLIdentifier(step.Relation)))
	}
	return plan.CTEs + "\n" + strings.Join(branches, " UNION ALL "), args
}
