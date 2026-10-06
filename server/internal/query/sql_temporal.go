package query

import (
	"errors"
	"strconv"
	"strings"
)

// temporal lowers projection before aggregation. Only the chart-ready points
// field is serialized; dimensions, measures and trend statistics stay typed.
func (c *sqlCompiler) temporal(input SQLRelation, definition TemporalSeries, queryName string) (SQLRelation, error) {
	if definition.Shape != "" && definition.Shape != "tidy" && definition.Shape != "groups" && definition.Shape != "panels" {
		return SQLRelation{}, errors.New("unsupported temporal-series shape")
	}
	if definition.Link != "" && definition.Shape != "panels" {
		return SQLRelation{}, errors.New("temporal link requires panels")
	}
	if len(definition.Carry) > 16 || len(definition.Measures) > 64 || len(definition.Maps) > 64 ||
		len(definition.Measures)+len(definition.Maps) == 0 {
		return SQLRelation{}, errors.New("invalid temporal-series declaration bounds")
	}
	if definition.Trend != nil {
		if definition.Shape != "groups" || definition.Trend.Direction == "" {
			return SQLRelation{}, errors.New("temporal trend requires groups and a carried direction field")
		}
		found := false
		for _, field := range definition.Carry {
			found = found || field == definition.Trend.Direction
		}
		if !found {
			return SQLRelation{}, errors.New("temporal trend direction must be carried")
		}
	}
	// Private aliases keep lateral map columns from shadowing source fields.
	input = qualifyRelation(c.materialize(input, queryName, "temporal-input", 0), "ts")
	timeColumn := sqlField(input, definition.Time)
	if timeColumn.Kind != SQLText && timeColumn.Kind != SQLTimestamp {
		return SQLRelation{}, errors.New("temporal time requires text or a typed timestamp")
	}
	seriesColumn := sqlField(input, definition.Series)
	if seriesColumn.Kind == SQLStructured {
		return SQLRelation{}, errors.New("temporal series requires a scalar dimension")
	}

	carried := make([]SQLColumn, len(definition.Carry))
	carryProjection := make([]string, len(carried))
	carryFields := make([]string, len(carried))
	for index, field := range definition.Carry {
		column, exists := input.Columns[field]
		if !exists {
			column = SQLColumn{Expression: "NULL::text", Presence: "FALSE", Kind: sqlNull}
		}
		if column.Kind == SQLStructured {
			return SQLRelation{}, errors.New("temporal carry requires scalar dimensions")
		}
		carried[index] = column
		carryFields[index] = SQLIdentifier("carry" + strconv.Itoa(index))
		carryProjection[index] = "CASE WHEN " + column.Presence + " THEN " + column.Expression +
			" ELSE NULL END AS " + carryFields[index]
	}
	timeText := temporalScalarText(timeColumn)
	at := timeColumn.Expression
	if timeColumn.Kind == SQLText {
		// pg_input_is_valid is a non-throwing input check, not an attempted cast.
		// Reject PostgreSQL's relative/symbolic dates which Date.parse rejects.
		at = "CASE WHEN " + timeColumn.Presence + " AND " + timeText +
			` ~ '^([0-9]|[A-Za-z]{3}[ ,/])' AND ` + timeText + ` ~ '[0-9]' AND pg_input_is_valid(` +
			timeText + ", 'timestamp with time zone') THEN (" + timeText + ")::timestamptz ELSE NULL::timestamptz END"
	}
	validTime := "CASE WHEN " + timeColumn.Presence + " THEN isfinite(" + at + ") ELSE FALSE END"
	series := temporalScalarText(seriesColumn)
	link := "'{}'::jsonb"
	if definition.Link != "" {
		column := sqlField(input, definition.Link)
		if column.Kind != SQLStructured && column.Kind != sqlNull {
			return SQLRelation{}, errors.New("temporal link requires a structured field")
		}
		link = "CASE WHEN " + column.Presence + " THEN jsonb_build_object('link', " +
			column.Expression + ") ELSE '{}'::jsonb END"
	}
	var branches []string
	appendBranch := func(declaration int, entry, metric, key, name, kind, group, value, lateral string) {
		projection := make([]string, 0, 12+len(carryProjection))
		projection = append(projection,
			input.Order+` AS "__source"`, strconv.Itoa(declaration)+` AS "__declaration"`,
			entry+` AS "__entry"`, timeText+` AS "time"`,
			"floor(extract(epoch FROM ("+at+`))*1000) AS "__at"`,
			series+` AS "series"`, metric+` AS "metric"`, key+` AS "metric-key"`,
			name+` AS "metric-name"`, kind+` AS "metric-kind"`, group+` AS "metric-group"`,
			`tv.number AS "value"`,
			link+` AS "__link"`,
		)
		projection = append(projection, carryProjection...)
		branches = append(branches, "SELECT "+strings.Join(projection, ",")+" FROM "+input.SQL+lateral+
			" CROSS JOIN LATERAL (SELECT "+value+" AS number) AS tv WHERE "+validTime+" AND tv.number IS NOT NULL")
	}
	for index, measure := range definition.Measures {
		if measure.Field == "" || measure.Kind == "" {
			return SQLRelation{}, errors.New("temporal measure requires field and kind")
		}
		column := sqlField(input, measure.Field)
		fallback := c.bind(measure.Field) + "::text"
		metric := fallback
		if measure.Key != "" {
			key := sqlField(input, measure.Key)
			metric = "coalesce(nullif(" + temporalScalarText(key) + ", ''), " + fallback + ")"
		}
		kind := c.bind(measure.Kind) + "::text"
		appendBranch(index, "0", metric, kind+" || ':' || "+metric, metric, kind, metric, temporalNumber(column), "")
	}
	for index, mapping := range definition.Maps {
		if mapping.Field == "" || mapping.Kind == "" {
			return SQLRelation{}, errors.New("temporal map requires field and kind")
		}
		column := sqlField(input, mapping.Field)
		if column.Kind != SQLStructured {
			return SQLRelation{}, errors.New("temporal map requires a virtual numeric mapping")
		}
		group := c.bind(mapping.Field) + "::text"
		if mapping.Group != "" {
			column := sqlField(input, mapping.Group)
			group = "coalesce(nullif(" + temporalScalarText(column) + ", ''), " + group + ")"
		}
		kind := c.bind(mapping.Kind) + "::text"
		// JSONB cannot retain insertion order. Canonical virtual maps therefore
		// use index-key order followed by C-collated text-key order, explicitly.
		keyOrder := `CASE WHEN key ~ '^(0|[1-9][0-9]{0,9})$' THEN CASE WHEN key::numeric < 4294967295 THEN key::numeric END END NULLS LAST, key COLLATE "C"`
		values := "CASE WHEN " + column.Presence + " AND jsonb_typeof(" + column.Expression +
			") = 'object' THEN " + column.Expression + " ELSE '{}'::jsonb END"
		lateral := " CROSS JOIN LATERAL (SELECT key, value, row_number() OVER (ORDER BY " + keyOrder +
			") AS ordinal FROM jsonb_each(" + values + ") ORDER BY " + keyOrder + " LIMIT 64) AS tm"
		mapValue := SQLColumn{Expression: "(tm.value #>> '{}')", Presence: "TRUE", Kind: SQLText}
		value := "CASE jsonb_typeof(tm.value) WHEN 'number' THEN " + temporalNumber(mapValue) +
			" WHEN 'string' THEN " + temporalNumber(mapValue) +
			" WHEN 'boolean' THEN CASE WHEN tm.value = 'true'::jsonb THEN 1::numeric ELSE 0::numeric END ELSE NULL::numeric END"
		name := "tm.key"
		if mapping.Definitions != "" {
			definitions := sqlField(input, mapping.Definitions)
			if definitions.Kind != SQLStructured {
				return SQLRelation{}, errors.New("temporal metric definitions require a virtual array")
			}
			array := "CASE WHEN " + definitions.Presence + " AND jsonb_typeof(" + definitions.Expression +
				") = 'array' THEN " + definitions.Expression + " ELSE '[]'::jsonb END"
			id := temporalJSONScalar("td.value->'id'")
			label := temporalJSONScalar("td.value->'name'")
			name = "coalesce((SELECT coalesce(nullif(" + label + ", ''), tm.key) FROM jsonb_array_elements(" +
				array + ") WITH ORDINALITY AS td(value, ordinal) WHERE " + id +
				" = tm.key AND " + id + " <> '' ORDER BY td.ordinal DESC LIMIT 1), tm.key)"
		}
		appendBranch(len(definition.Measures)+index, "tm.ordinal", "tm.key", kind+" || ':' || "+group+" || ':' || tm.key",
			name, kind, group, value, lateral)
	}

	fields := map[string]SQLColumn{}
	for _, field := range []string{"time", "series", "metric", "metric-key", "metric-name", "metric-kind", "metric-group"} {
		fields[field] = SQLColumn{Expression: SQLIdentifier(field), Presence: "TRUE", Kind: SQLText}
	}
	fields["value"] = SQLColumn{Expression: `"value"`, Presence: "TRUE", Kind: SQLNumber}
	fields["__at"] = SQLColumn{Expression: `"__at"`, Presence: "TRUE", Kind: SQLNumber}
	fields["__link"] = SQLColumn{Expression: `"__link"`, Presence: "TRUE", Kind: SQLStructured}
	for index, column := range carried {
		fields["carry"+strconv.Itoa(index)] = SQLColumn{Expression: carryFields[index], Presence: "TRUE", Kind: column.Kind}
	}
	// The sentinel is checked before grouping; a single group with too many
	// points must not bypass the tidy projection's 100k-row limit.
	numbered := "(SELECT expanded.*, row_number() OVER (ORDER BY " +
		`"__source","__declaration","__entry") AS "__order" FROM (` + strings.Join(branches, " UNION ALL ") +
		`) AS expanded ORDER BY "__source","__declaration","__entry" LIMIT 100001) AS numbered`
	bounded := "(SELECT numbered.*, count(*) OVER () AS __count FROM " + numbered + ") AS bounded"
	tidy := c.materialize(SQLRelation{SQL: bounded + " WHERE 1 / CASE WHEN __count <= 100000 THEN 1 ELSE 0 END = 1",
		Columns: fields, Order: `"__order"`}, queryName, "temporal-series", 1)
	if definition.Shape == "panels" {
		return c.temporalPanels(tidy, carried, definition, queryName), nil
	}
	if definition.Shape != "groups" {
		output := map[string]SQLColumn{}
		for index, field := range definition.Carry {
			output[field] = tidy.Columns["carry"+strconv.Itoa(index)]
		}
		for _, field := range []string{"time", "series", "metric", "metric-key", "metric-name", "metric-kind", "metric-group", "value"} {
			output[field] = tidy.Columns[field]
		}
		tidy.Columns = output
		return tidy, nil
	}
	return c.temporalGroups(tidy, carried, definition, queryName), nil
}

func (c *sqlCompiler) temporalPanels(tidy SQLRelation, carried []SQLColumn, definition TemporalSeries, queryName string) SQLRelation {
	metadata := []string{"metric", "metric-key", "metric-name", "metric-kind", "metric-group"}
	keys := make([]string, 0, len(metadata)+len(carried))
	columns := map[string]SQLColumn{}
	for _, field := range metadata {
		keys = append(keys, SQLIdentifier(field))
		columns[field] = SQLColumn{Expression: SQLIdentifier(field), Presence: "TRUE", Kind: SQLText}
	}
	for index, column := range carried {
		field := "carry" + strconv.Itoa(index)
		keys = append(keys, SQLIdentifier(field))
		columns[definition.Carry[index]] = SQLColumn{Expression: SQLIdentifier(field), Presence: "TRUE", Kind: column.Kind}
	}
	projection := make([]string, 0, len(keys)+7)
	partition := []string{tidy.Columns["metric-key"].Expression}
	for index := range carried {
		partition = append(partition, tidy.Columns["carry"+strconv.Itoa(index)].Expression)
	}
	first := "PARTITION BY " + strings.Join(partition, ",") + " ORDER BY " + tidy.Order +
		" ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING"
	for _, field := range metadata {
		projection = append(projection, "first_value("+tidy.Columns[field].Expression+") OVER ("+first+") AS "+SQLIdentifier(field))
	}
	for index := range carried {
		field := "carry" + strconv.Itoa(index)
		projection = append(projection, tidy.Columns[field].Expression+" AS "+SQLIdentifier(field))
	}
	for _, field := range []string{"series", "time", "value", "__at", "__link"} {
		projection = append(projection, tidy.Columns[field].Expression+" AS "+SQLIdentifier(field))
	}
	projection = append(projection, tidy.Order+` AS "__order"`)
	input := "(SELECT " + strings.Join(projection, ",") + " FROM " + tidy.SQL + ") AS panel_input"
	groupKeys := strings.Join(keys, ",")
	point := `jsonb_build_object('x',"time",'y',"value",'key',"metric-key" || ':' || ("__order"-1)::text) || "__link"`
	series := "(SELECT " + groupKeys + `,"series",min("__order") AS "__order",jsonb_agg(` +
		point + ` ORDER BY "__at","__order") AS "points" FROM ` + input +
		" GROUP BY " + groupKeys + `,"series") AS panel_series`
	panels := "(SELECT " + groupKeys + `,min("__order") AS "__order",jsonb_agg(jsonb_build_object(` +
		`'id',"series",'label',"series",'points',"points") ORDER BY "series" COLLATE "C") AS "series" FROM ` +
		series + " GROUP BY " + groupKeys + ") AS panels"
	columns["series"] = SQLColumn{Expression: `"series"`, Presence: "TRUE", Kind: SQLStructured}
	return c.materialize(SQLRelation{SQL: panels, Columns: columns, Order: `"__order"`}, queryName, "temporal-panels", 1)
}

func temporalScalarText(column SQLColumn) string {
	return "CASE WHEN " + column.Presence + " THEN " + sqlText(column) + " ELSE ''::text END"
}

func temporalNumber(column SQLColumn) string {
	number := sqlNumeric(column)
	switch column.Kind {
	case SQLBoolean:
		number = "CASE WHEN " + column.Expression + " THEN 1::numeric WHEN NOT (" + column.Expression + ") THEN 0::numeric END"
	case SQLText:
		number = "CASE WHEN " + column.Expression + " = '' THEN NULL::numeric WHEN trim(" +
			column.Expression + ") = '' THEN 0::numeric ELSE " + number + " END"
	case SQLNumber, SQLTimestamp, SQLStructured, sqlNull:
	}
	return "CASE WHEN " + column.Presence + " THEN " + sqlFinite(number) + " ELSE NULL::numeric END"
}

func temporalJSONScalar(expression string) string {
	return "CASE WHEN jsonb_typeof(" + expression + ") IN ('string','number','boolean') THEN (" +
		expression + " #>> '{}') ELSE ''::text END"
}

func (c *sqlCompiler) temporalGroups(tidy SQLRelation, carried []SQLColumn, definition TemporalSeries, queryName string) SQLRelation {
	key := make([]string, 0, 1+len(carried))
	key = append(key, tidy.Columns["metric-key"].Expression)
	for index := range carried {
		key = append(key, tidy.Columns["carry"+strconv.Itoa(index)].Expression)
	}
	partition := "PARTITION BY " + strings.Join(key, ",")
	first := partition + " ORDER BY " + tidy.Order + " ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING"
	columns := map[string]SQLColumn{}
	windowProjection := []string{tidy.Order + ` AS "__order"`}
	for index, column := range carried {
		alias := "carry" + strconv.Itoa(index)
		expression := tidy.Columns[alias].Expression
		windowProjection = append(windowProjection, expression+" AS "+SQLIdentifier(alias))
		columns[definition.Carry[index]] = SQLColumn{Expression: SQLIdentifier(alias), Presence: "TRUE", Kind: column.Kind}
	}
	metadata := []string{"metric", "metric-key", "metric-name", "metric-kind", "metric-group"}
	for _, field := range metadata {
		windowProjection = append(windowProjection, "first_value("+tidy.Columns[field].Expression+") OVER ("+first+") AS "+SQLIdentifier(field))
		columns[field] = SQLColumn{Expression: SQLIdentifier(field), Presence: "TRUE", Kind: SQLText}
	}
	windowProjection = append(windowProjection,
		tidy.Columns["time"].Expression+` AS "time"`, tidy.Columns["series"].Expression+` AS "series"`,
		tidy.Columns["value"].Expression+` AS "value"`, tidy.Columns["__at"].Expression+` AS "__at"`)
	if definition.Trend != nil {
		for _, order := range []struct{ alias, direction string }{{"start", "ASC"}, {"end", "DESC"}} {
			windowProjection = append(windowProjection, "first_value("+tidy.Columns["value"].Expression+
				") OVER ("+partition+" ORDER BY "+tidy.Columns["__at"].Expression+" "+order.direction+", "+tidy.Order+
				" "+order.direction+" ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS "+SQLIdentifier(order.alias))
		}
	}
	windowed := "(SELECT " + strings.Join(windowProjection, ",") + " FROM " + tidy.SQL + ") AS temporal_window"
	groupBy := append([]string{}, metadata...)
	for index := range carried {
		groupBy = append(groupBy, "carry"+strconv.Itoa(index))
	}
	for index, field := range groupBy {
		groupBy[index] = SQLIdentifier(field)
	}
	projection := append([]string{}, groupBy...)
	projection = append(projection, `min("__order") AS "__order"`,
		`jsonb_agg(jsonb_build_object('x',"time",'y',"value",'color',"series",'key',"metric-key" || ':' || ("__order"-1)::text) ORDER BY "__at","__order") AS "points"`)
	columns["points"] = SQLColumn{Expression: `"points"`, Presence: "TRUE", Kind: SQLStructured, Point: "temporal"}
	if definition.Trend != nil {
		projection = append(projection, `count(*) AS "count"`, `min("start") AS "start"`, `min("end") AS "end"`)
	}
	grouped := "(SELECT " + strings.Join(projection, ",") + " FROM " + windowed + " GROUP BY " +
		strings.Join(groupBy, ",") + ") AS temporal_group"
	if definition.Trend != nil {
		direction := temporalScalarText(columns[definition.Trend.Direction])
		delta := `("end"-"start")`
		observed := "CASE WHEN " + delta + " > 0 THEN 'up' WHEN " + delta + " < 0 THEN 'down' ELSE 'flat' END"
		statistics := map[string]SQLColumn{
			"trend-start-value":        {Expression: `"start"`, Kind: SQLNumber},
			"trend-end-value":          {Expression: `"end"`, Kind: SQLNumber},
			"trend-delta":              {Expression: delta, Kind: SQLNumber},
			"trend-relative-percent":   {Expression: delta + ` / nullif(abs("start"),0) * 100`, Kind: SQLNumber},
			"trend-observed-direction": {Expression: observed, Kind: SQLText},
		}
		for field, column := range statistics {
			column.Expression = `CASE WHEN "count" >= 2 THEN ` + column.Expression + " ELSE NULL END"
			column.Presence = `"count" >= 2`
			columns[field] = column
		}
		columns["trend-observation-count"] = SQLColumn{Expression: `"count"`, Presence: "TRUE", Kind: SQLNumber}
		assessment := `CASE WHEN "count" < 2 THEN 'insufficient' WHEN ` + delta + ` = 0 THEN 'stable' WHEN (` +
			direction + ` = 'increase' AND ` + delta + ` > 0) OR (` + direction + ` = 'decrease' AND ` + delta +
			` < 0) THEN 'improving' WHEN (` + direction + ` = 'increase' AND ` + delta + ` < 0) OR (` +
			direction + ` = 'decrease' AND ` + delta + ` > 0) THEN 'worsening' ELSE 'neutral' END`
		columns["trend-assessment"] = SQLColumn{Expression: assessment, Presence: "TRUE", Kind: SQLText}
	}
	return c.materialize(SQLRelation{SQL: grouped, Columns: columns, Order: `"__order"`}, queryName, "temporal-groups", 1)
}
