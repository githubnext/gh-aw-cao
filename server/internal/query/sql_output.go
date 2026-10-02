package query

import (
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/sqlbuilder"
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
	builder := sqlbuilder.New(plan.Args...)
	builder.Write("{}\nSELECT {} FROM {} ORDER BY {} LIMIT {} OFFSET {}",
		sqlbuilder.Fragment(plan.CTEs), sqlbuilder.Fragment(strings.Join(projection, ",")),
		sqlbuilder.Fragment(relation.SQL), sqlbuilder.Fragment(relation.Order), limit, offset)
	statement, args, err := builder.Statement()
	return statement, args, fields, err
}

// StatisticsStatement performs cardinality and byte accounting in Postgres,
// without fetching or reconstructing collections in Go.
func (plan SQLPlan) StatisticsStatement() (string, []any, error) {
	seen := map[string]bool{}
	var branches []string
	builder := sqlbuilder.New(plan.Args...)
	for _, step := range plan.Steps {
		if seen[step.Relation] {
			continue
		}
		seen[step.Relation] = true
		bound := builder.Bind(step.Relation)
		branches = append(branches, fmt.Sprintf("SELECT %s::text AS relation, count(*) AS rows, coalesce(sum(pg_column_size(r)),0) AS bytes FROM %s AS r",
			bound, SQLIdentifier(step.Relation)))
	}
	builder.Write("{}\n{}", sqlbuilder.Fragment(plan.CTEs), sqlbuilder.Fragment(strings.Join(branches, " UNION ALL ")))
	return builder.Statement()
}
