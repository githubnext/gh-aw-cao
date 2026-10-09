package query

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func (w *WindowField) UnmarshalJSON(data []byte) error {
	type windowField WindowField
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for _, key := range []string{"groupby", "frame", "reducer", "alignment", "mode", "time-field", "unit"} {
		if value, exists := raw[key]; exists && strings.TrimSpace(string(value)) == "null" {
			return fmt.Errorf("window %s cannot be null", key)
		}
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var decoded windowField
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*w = WindowField(decoded)
	return nil
}

// windowRejectionStage identifies which precondition validateWindows failed,
// so a misconfigured dashboard query's window clause is diagnosable without
// logging the field names, output names, or other query-author-supplied
// content a rejection would otherwise require.
type windowRejectionStage string

const (
	windowRejectionStageNone      windowRejectionStage = "none"
	windowRejectionStageCount     windowRejectionStage = "count"
	windowRejectionStageOutput    windowRejectionStage = "output"
	windowRejectionStageOrderBy   windowRejectionStage = "order-by"
	windowRejectionStageGroupBy   windowRejectionStage = "groupby"
	windowRejectionStageRolling   windowRejectionStage = "rolling"
	windowRejectionStageChange    windowRejectionStage = "change"
	windowRejectionStageOperation windowRejectionStage = "operation"
)

// isValidWindowOrderBy reports whether a window entry's order-by clause has
// between 1 and 8 fields, each with a nonempty field name and either no
// direction or "asc"/"desc". It is a pure function extracted from
// validateWindows so this precondition is independently testable against a
// constructed []OrderField, without a full WindowField or query Definition.
func isValidWindowOrderBy(orderBy []OrderField) bool {
	if len(orderBy) == 0 || len(orderBy) > 8 {
		return false
	}
	for _, field := range orderBy {
		if field.Field == "" || (field.Direction != "" && field.Direction != "asc" && field.Direction != "desc") {
			return false
		}
	}
	return true
}

// isValidWindowGroupBy reports whether a window entry's groupby clause has
// at most 8 fields, is either nil or nonempty, and contains only nonempty,
// distinct field names. It is a pure function extracted from
// validateWindows so this precondition is independently testable against a
// constructed []string, without a full WindowField.
func isValidWindowGroupBy(groupBy []string) bool {
	if len(groupBy) > 8 || (groupBy != nil && len(groupBy) == 0) {
		return false
	}
	groups := map[string]bool{}
	for _, field := range groupBy {
		if field == "" || groups[field] {
			return false
		}
		groups[field] = true
	}
	return true
}

// isValidRollingWindow reports whether entry's rolling-specific fields
// (frame, alignment, reducer) are well formed and no change-only fields
// (mode, time-field, unit) are set. It is a pure function extracted from
// validateWindows so the "rolling" operation's precondition is independently
// testable against a constructed WindowField.
func isValidRollingWindow(entry WindowField) bool {
	return entry.Frame != nil && *entry.Frame >= 1 && *entry.Frame <= 1000 &&
		(entry.Alignment == "" || entry.Alignment == "trailing" || entry.Alignment == "centered") &&
		!(entry.Alignment == "centered" && *entry.Frame%2 == 0) &&
		(entry.Reducer == "" || entry.Reducer == "mean" || entry.Reducer == "sum" || entry.Reducer == "min" || entry.Reducer == "max") &&
		entry.Mode == "" && entry.TimeField == "" && entry.Unit == ""
}

// isValidChangeWindow reports whether entry's change-specific fields (mode,
// time-field, unit) are well formed and no rolling-only fields (frame,
// alignment, reducer) are set. It is a pure function extracted from
// validateWindows so the "change" operation's precondition is independently
// testable against a constructed WindowField.
func isValidChangeWindow(entry WindowField) bool {
	if entry.Frame != nil || entry.Alignment != "" || entry.Reducer != "" {
		return false
	}
	if entry.Mode != "" && entry.Mode != "absolute" && entry.Mode != "percentage" && entry.Mode != "rate" {
		return false
	}
	if entry.Mode == "rate" {
		return entry.TimeField != "" &&
			(entry.Unit == "second" || entry.Unit == "minute" || entry.Unit == "hour" || entry.Unit == "day")
	}
	return entry.TimeField == "" && entry.Unit == ""
}

// windowRejectionMessages maps each non-passing windowRejectionStage to the
// error text validateWindows previously returned inline for that case, so
// classifyWindowEntry's stage and validateWindows' returned error always
// describe the same rejection.
var windowRejectionMessages = map[windowRejectionStage]string{
	windowRejectionStageCount:     "window must contain between 1 and 8 entries",
	windowRejectionStageOutput:    "window requires a field and unique output name",
	windowRejectionStageOrderBy:   "window order-by must contain 1 to 8 fields",
	windowRejectionStageGroupBy:   "window groupby fields must be nonempty and distinct",
	windowRejectionStageRolling:   "invalid rolling window",
	windowRejectionStageChange:    "invalid change window",
	windowRejectionStageOperation: "unsupported window operation",
}

// classifyWindowEntry reports the first precondition a single window entry
// fails, consulting and updating outputs to track output names already
// claimed by earlier entries. It is extracted from validateWindows so each
// entry-level rejection stage is independently testable against a
// constructed WindowField and outputs map, without a full window list.
func classifyWindowEntry(entry WindowField, outputs map[string]bool) windowRejectionStage {
	if entry.Field == "" || entry.As == "" || outputs[entry.As] {
		return windowRejectionStageOutput
	}
	outputs[entry.As] = true
	if !isValidWindowOrderBy(entry.OrderBy) {
		return windowRejectionStageOrderBy
	}
	if !isValidWindowGroupBy(entry.GroupBy) {
		return windowRejectionStageGroupBy
	}
	switch entry.Operation {
	case "rolling":
		if !isValidRollingWindow(entry) {
			return windowRejectionStageRolling
		}
	case "change":
		if !isValidChangeWindow(entry) {
			return windowRejectionStageChange
		}
	default:
		return windowRejectionStageOperation
	}
	return windowRejectionStageNone
}

func validateWindows(windows []WindowField) error {
	stage := windowRejectionStageNone
	if len(windows) == 0 || len(windows) > 8 {
		stage = windowRejectionStageCount
	} else {
		outputs := map[string]bool{}
		for _, entry := range windows {
			if stage = classifyWindowEntry(entry, outputs); stage != windowRejectionStageNone {
				break
			}
		}
	}
	if stage == windowRejectionStageNone {
		return nil
	}
	queryLog.Printf("window validation rejected stage=%s", stage)
	return errors.New(windowRejectionMessages[stage])
}

func windowInstant(column SQLColumn) string {
	if column.Kind == SQLTimestamp {
		return "extract(epoch FROM " + column.Expression + ")::numeric"
	}
	if column.Kind != SQLText {
		return "NULL::numeric"
	}
	text := column.Expression
	// Validate the calendar day before casting; PostgreSQL's timestamp cast
	// otherwise raises on a malformed observation instead of yielding null.
	date := "substring(" + text + " from 1 for 10)"
	year := "substring(" + text + " from 1 for 4)::int"
	month := "substring(" + text + " from 6 for 2)::int"
	day := "substring(" + text + " from 9 for 2)::int"
	valid := year + " BETWEEN 1 AND 9999 AND " + month + " BETWEEN 1 AND 12 AND " + day + " BETWEEN 1 AND 31"
	validDate := "to_char(make_date(" + year + ", " + month + ", 1) + (" + day +
		" - 1) * interval '1 day', 'YYYY-MM-DD') = " + date
	hour := "substring(" + text + " from 12 for 2)::int"
	minute := "substring(" + text + " from 15 for 2)::int"
	second := "substring(" + text + " from 18 for 2)::int"
	offsetHour := "substring(" + text + " from '[+-]([0-9]{2}):[0-9]{2}$')::int"
	offsetMinute := "substring(" + text + " from '[+-][0-9]{2}:([0-9]{2})$')::int"
	fraction := "coalesce(('0.' || left(substring(" + text + " from '[.]([0-9]+)'), 3))::numeric, 0::numeric)"
	offset := "(CASE WHEN substring(" + text + " from '[+-][0-9]{2}:[0-9]{2}$') LIKE '-%' THEN -1 ELSE 1 END) * " +
		"(coalesce(" + offsetHour + ", 0) * 3600 + coalesce(" + offsetMinute + ", 0) * 60)"
	instant := "extract(epoch FROM ((make_date(" + year + ", " + month + ", 1) + (" + day +
		" - 1) * interval '1 day') AT TIME ZONE 'UTC'))::numeric + CASE WHEN length(" + text + ") = 10 THEN 0 ELSE " +
		hour + " * 3600 + " + minute + " * 60 + " + second + " + " + fraction + " - " + offset + " END"
	return "CASE WHEN " + text + ` ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$)'` +
		" THEN CASE WHEN " + valid + " THEN CASE WHEN " + validDate +
		" AND (length(" + text + ") = 10 OR (" + hour + " <= 23 AND " +
		minute + " <= 59 AND " + second + " <= 59 AND " +
		"CASE WHEN " + text + ` ~ '[+-][0-9]{2}:[0-9]{2}$' THEN ` +
		offsetHour + " <= 23 AND " + offsetMinute + " <= 59 ELSE TRUE END))" +
		" THEN " + instant + " END END END"
}

func (c *sqlCompiler) windowTextSortKeys(input SQLRelation, entry WindowField, name string) (SQLRelation, map[int]string) {
	partition := make([]string, 0, 2*len(entry.GroupBy))
	for _, field := range entry.GroupBy {
		column := sqlField(input, field)
		partition = append(partition, column.Presence, column.Expression)
	}
	over := "OVER ()"
	if len(partition) != 0 {
		over = "OVER (PARTITION BY " + strings.Join(partition, ",") + ")"
	}
	helpers := map[int]string{}
	for index, clause := range entry.OrderBy {
		column := sqlField(input, clause.Field)
		if column.Kind != SQLText {
			continue
		}
		key := fmt.Sprintf("__window_numeric_sort_%d", index)
		for {
			if _, exists := input.Columns[key]; !exists {
				break
			}
			key += "_"
		}
		numeric := sqlFinite(sqlNumeric(SQLColumn{Expression: "replace(" + column.Expression + ", ',', '')", Kind: SQLText}))
		valid := "coalesce(bool_and(" + numeric + " IS NOT NULL) FILTER (WHERE " + column.Expression +
			" IS NOT NULL AND " + column.Expression + " <> '') " + over + ", FALSE)"
		input.Columns[key] = SQLColumn{Expression: valid, Presence: "TRUE", Kind: SQLBoolean}
		helpers[index] = key
	}
	if len(helpers) == 0 {
		return input, nil
	}
	original := input.Columns
	input = c.materialize(input, name, "window-sort-key", len(helpers))
	sorts := make(map[int]string, len(helpers))
	for index, key := range helpers {
		sorts[index] = input.Columns[key].Expression
		delete(original, key)
		delete(input.Columns, key)
	}
	return input, sorts
}

func (c *sqlCompiler) window(input SQLRelation, entry WindowField, name string) (SQLRelation, error) {
	value := sqlField(input, entry.Field)
	if value.Kind == SQLStructured {
		return SQLRelation{}, errors.New("structured window values are forbidden")
	}
	partition := []string{}
	for _, field := range entry.GroupBy {
		group := sqlField(input, field)
		if group.Kind == SQLStructured {
			return SQLRelation{}, errors.New("structured window partitions are forbidden")
		}
		partition = append(partition, group.Presence, group.Expression)
	}
	var numericSort map[int]string
	input, numericSort = c.windowTextSortKeys(input, entry, name)
	value = sqlField(input, entry.Field)
	partition = partition[:0]
	for _, field := range entry.GroupBy {
		group := sqlField(input, field)
		partition = append(partition, group.Presence, group.Expression)
	}
	order := make([]string, 0, len(entry.OrderBy)+1)
	for index, field := range entry.OrderBy {
		column := sqlField(input, field.Field)
		if column.Kind == SQLStructured {
			return SQLRelation{}, errors.New("structured window order fields are forbidden")
		}
		direction := "ASC"
		if field.Direction == "desc" {
			direction = "DESC"
		}
		expression := column.Expression
		if column.Kind == SQLText {
			expression = "nullif(" + expression + ", '')"
			if numeric, ok := numericSort[index]; ok {
				asNumber := sqlFinite(sqlNumeric(SQLColumn{Expression: "replace(" + column.Expression + ", ',', '')", Kind: SQLText}))
				order = append(order, "CASE WHEN "+numeric+" THEN "+asNumber+" END "+direction+" NULLS LAST")
				expression = "CASE WHEN NOT " + numeric + " THEN " + expression + " END"
			}
		}
		order = append(order, expression+" "+direction+" NULLS LAST")
	}
	order = append(order, input.Order+" ASC")
	over := ""
	if len(partition) > 0 {
		over = "PARTITION BY " + strings.Join(partition, ",") + " "
	}
	over += "ORDER BY " + strings.Join(order, ",")
	numeric := sqlFinite(sqlNumeric(value))
	var result string
	if entry.Operation == "rolling" {
		reducer := entry.Reducer
		if reducer == "" || reducer == "mean" {
			reducer = "avg"
		}
		frame := fmt.Sprintf("ROWS BETWEEN %d PRECEDING AND CURRENT ROW", *entry.Frame-1)
		if entry.Alignment == "centered" {
			half := (*entry.Frame - 1) / 2
			frame = fmt.Sprintf("ROWS BETWEEN %d PRECEDING AND %d FOLLOWING", half, half)
		}
		window := " OVER (" + over + " " + frame + ")"
		result = reducer + "(" + numeric + ")" + window
		if entry.Alignment == "centered" {
			result = "CASE WHEN count(*)" + window + fmt.Sprintf(" = %d THEN %s END", *entry.Frame, result)
		}
	} else {
		previous := "lag(" + numeric + ") OVER (" + over + ")"
		difference := "(" + numeric + " - " + previous + ")"
		switch entry.Mode {
		case "percentage":
			result = "100::numeric * " + difference + " / nullif(" + previous + ", 0)"
		case "rate":
			time := sqlField(input, entry.TimeField)
			if time.Kind == SQLStructured {
				return SQLRelation{}, errors.New("structured window time field is forbidden")
			}
			instant := windowInstant(time)
			prior := "lag(" + instant + ") OVER (" + over + ")"
			seconds := map[string]int{"second": 1, "minute": 60, "hour": 3600, "day": 86400}[entry.Unit]
			elapsed := "(" + instant + " - " + prior + ")"
			result = "CASE WHEN " + elapsed + " > 0 THEN " + difference + fmt.Sprintf(" * %d::numeric / %s END", seconds, elapsed)
		default:
			result = difference
		}
	}
	columns := make(map[string]SQLColumn, len(input.Columns)+1)
	for field, column := range input.Columns {
		columns[field] = column
	}
	columns[entry.As] = SQLColumn{Expression: sqlFinite(result), Presence: "TRUE", Kind: SQLNumber}
	weight := 32
	if entry.Operation == "rolling" {
		weight += *entry.Frame
	} else {
		weight++
	}
	return c.materialize(SQLRelation{SQL: input.SQL, Columns: columns, Order: input.Order}, name, "window", weight), nil
}
