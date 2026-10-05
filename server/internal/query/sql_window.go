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

func validateWindows(windows []WindowField) error {
	if len(windows) == 0 || len(windows) > 8 {
		return errors.New("window must contain between 1 and 8 entries")
	}
	outputs := map[string]bool{}
	for _, entry := range windows {
		if entry.Field == "" || entry.As == "" || outputs[entry.As] {
			return errors.New("window requires a field and unique output name")
		}
		outputs[entry.As] = true
		if len(entry.OrderBy) == 0 || len(entry.OrderBy) > 8 {
			return errors.New("window order-by must contain 1 to 8 fields")
		}
		for _, field := range entry.OrderBy {
			if field.Field == "" || (field.Direction != "" && field.Direction != "asc" && field.Direction != "desc") {
				return errors.New("window order-by contains an invalid field or direction")
			}
		}
		if len(entry.GroupBy) > 8 || (entry.GroupBy != nil && len(entry.GroupBy) == 0) {
			return errors.New("window groupby must contain 1 to 8 fields")
		}
		groups := map[string]bool{}
		for _, field := range entry.GroupBy {
			if field == "" || groups[field] {
				return errors.New("window groupby fields must be nonempty and distinct")
			}
			groups[field] = true
		}
		switch entry.Operation {
		case "rolling":
			if entry.Frame == nil || *entry.Frame < 1 || *entry.Frame > 1000 ||
				(entry.Alignment != "" && entry.Alignment != "trailing" && entry.Alignment != "centered") ||
				(entry.Alignment == "centered" && *entry.Frame%2 == 0) ||
				(entry.Reducer != "" && entry.Reducer != "mean" && entry.Reducer != "sum" && entry.Reducer != "min" && entry.Reducer != "max") ||
				entry.Mode != "" || entry.TimeField != "" || entry.Unit != "" {
				return errors.New("invalid rolling window")
			}
		case "change":
			if entry.Frame != nil || entry.Alignment != "" || entry.Reducer != "" ||
				(entry.Mode != "" && entry.Mode != "absolute" && entry.Mode != "percentage" && entry.Mode != "rate") ||
				(entry.Mode == "rate" && (entry.TimeField == "" ||
					(entry.Unit != "second" && entry.Unit != "minute" && entry.Unit != "hour" && entry.Unit != "day"))) ||
				(entry.Mode != "rate" && (entry.TimeField != "" || entry.Unit != "")) {
				return errors.New("invalid change window")
			}
		default:
			return errors.New("unsupported window operation")
		}
	}
	return nil
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
	partition := []string{}
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
