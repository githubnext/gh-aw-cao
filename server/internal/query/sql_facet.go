package query

import (
	"errors"
	"strings"
)

// Facet is a terminal wire projection over processed rows, never stored data.
func (c *sqlCompiler) facet(input SQLRelation, facet Facet, name string) (SQLRelation, error) {
	c.steps = append(c.steps, SQLStep{Query: name, Relation: strings.Trim(input.SQL, `"`), Operation: "facet", Weight: 1})
	categories := make([]string, 3)
	for index, field := range []string{facet.Field, facet.Row, facet.Column} {
		if field == "" {
			categories[index] = "NULL::jsonb"
			continue
		}
		column, exists := input.Columns[field]
		if !exists || column.Kind == SQLStructured {
			return SQLRelation{}, errors.New("facet requires existing scalar fields")
		}
		categories[index] = "CASE WHEN " + column.Presence + " THEN to_jsonb(" + column.Expression + ") ELSE NULL::jsonb END"
	}
	parts := []string{"'{}'::jsonb"}
	for _, field := range sortedSQLFields(input.Columns) {
		column := input.Columns[field]
		parts = append(parts, "CASE WHEN "+column.Presence+" THEN jsonb_build_object("+
			c.bind(field)+"::text,"+column.Expression+") ELSE '{}'::jsonb END")
	}
	sql := "SELECT " + categories[0] + ` AS field,` + categories[1] + ` AS row_value,` + categories[2] +
		` AS column_value,` + input.Order + ` AS ordinal,` + strings.Join(parts, " || ") + ` AS payload FROM ` + input.SQL
	grouped := `(SELECT field,row_value,column_value,min(ordinal) AS ordinal,` +
		`jsonb_agg(payload ORDER BY ordinal) AS payload FROM (` + sql +
		`) AS facet_input GROUP BY field,row_value,column_value)`
	// Rank each axis by first appearance, including null as an observed category.
	ranked := `(SELECT *,min(ordinal) OVER (PARTITION BY row_value) AS row_first,` +
		`min(ordinal) OVER (PARTITION BY column_value) AS column_first FROM ` + grouped + ` AS facet_groups)`
	projected := `(SELECT *,dense_rank() OVER (ORDER BY row_first)-1 AS row_index,` +
		`dense_rank() OVER (ORDER BY column_first)-1 AS column_index FROM ` + ranked + ` AS facet_ranked) AS facets`
	columns := map[string]SQLColumn{
		"facet-field":        {Expression: "field", Presence: "TRUE", Kind: SQLStructured},
		"facet-row":          {Expression: "row_value", Presence: "TRUE", Kind: SQLStructured},
		"facet-column":       {Expression: "column_value", Presence: "TRUE", Kind: SQLStructured},
		"facet-row-index":    {Expression: "row_index", Presence: "TRUE", Kind: SQLNumber},
		"facet-column-index": {Expression: "column_index", Presence: "TRUE", Kind: SQLNumber},
		facet.As:             {Expression: "payload", Presence: "TRUE", Kind: SQLStructured},
	}
	return c.materialize(SQLRelation{SQL: projected, Order: "ordinal", Columns: columns}, name, "facet-output", 0), nil
}
