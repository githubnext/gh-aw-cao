package dashboardquery

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var engineShardDay = regexp.MustCompile(`^(?:[^?#]*/)?([0-9]{4}-[0-9]{2}-[0-9]{2})-[0-9]{4,}-[a-fA-F0-9]{16}\.jsonl(?:[?#].*)?$`)
var engineTimestamp = regexp.MustCompile(`^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)

func engineCompute(rows []nativeRow, definitions []any, budget *engineBudget, ownedRows bool) ([]nativeRow, error) {
	result := make([]nativeRow, 0, len(rows))
	for i, row := range rows {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		out := row
		if !ownedRows {
			out = engineClone(row)
		}
		for _, item := range definitions {
			def := engineMap(item)
			value, err := engineComputeValue(out, def)
			if err != nil {
				return nil, err
			}
			out[engineString(def["as"])] = value
		}
		result = append(result, out)
	}
	return result, nil
}

func engineComputeValue(row nativeRow, definition nativeRow) (any, error) {
	args := engineList(definition["args"])
	values := make([]any, len(args))
	for i, item := range args {
		arg := engineMap(item)
		if field, ok := arg["field"]; ok {
			values[i] = row[engineString(field)]
		} else {
			// The caller substitutes scoped operands. An unbound parameter or
			// time context is null in the raw JavaScript row evaluator.
			values[i] = arg["value"]
		}
	}
	fn := engineString(definition["function"])
	switch fn {
	case "coalesce":
		for _, value := range values {
			if value != nil && value != "" && engineIsScalar(value) {
				return value, nil
			}
		}
		return nil, nil
	case "literal":
		if engineIsScalar(values[0]) {
			return values[0], nil
		}
		return nil, nil
	case "concat":
		text := ""
		for _, value := range values {
			text += engineText(value)
		}
		return text, nil
	case "lower":
		return engineLower(engineText(values[0])), nil
	case "upper":
		return engineUpper(engineText(values[0])), nil
	case "title-case":
		return engineTitleCase(engineText(values[0])), nil
	case "trim":
		return engineTrimSpace(engineText(values[0])), nil
	case "replace-suffix":
		text, suffix := engineText(values[0]), engineText(values[1])
		if suffix != "" && strings.HasSuffix(text, suffix) {
			return strings.TrimSuffix(text, suffix) + engineText(values[2]), nil
		}
		return text, nil
	case "url-encode":
		// encodeURIComponent leaves !'()* unescaped, unlike Go's query encoder.
		encoded := strings.ReplaceAll(url.QueryEscape(engineText(values[0])), "+", "%20")
		for _, pair := range [][2]string{{"%21", "!"}, {"%27", "'"}, {"%28", "("}, {"%29", ")"}, {"%2A", "*"}} {
			encoded = strings.ReplaceAll(encoded, pair[0], pair[1])
		}
		return encoded, nil
	case "timestamp":
		text, ok := values[0].(string)
		if !ok || !engineTimestamp.MatchString(text) || strings.HasPrefix(text, "0000-") {
			return nil, nil
		}
		value, ok := engineStrictTimestamp(text)
		if !ok {
			return nil, nil
		}
		return value, nil
	case "iso-timestamp":
		value, ok := engineNumber(values[0])
		if !ok || value < -62135596800000 || value > 253402300799999 {
			return nil, nil
		}
		return engineISO(value), nil
	case "sqrt":
		value, ok := engineNumber(values[0])
		if !ok || value < 0 {
			return nil, nil
		}
		return math.Sqrt(value), nil
	case "activity-shard-day":
		match := engineShardDay.FindStringSubmatch(engineText(values[0]))
		if len(match) == 0 {
			return nil, nil
		}
		if _, ok := engineStrictTimestamp(match[1] + "T00:00:00Z"); !ok {
			return nil, nil
		}
		return match[1], nil
	case "date-day", "date-bucket":
		milliseconds, ok := engineParseDate(values[0])
		if !ok {
			return nil, nil
		}
		date := time.UnixMilli(int64(milliseconds)).UTC()
		if fn == "date-day" {
			return engineISO(milliseconds)[:10], nil
		}
		unit := engineString(values[1])
		date = date.Truncate(time.Hour)
		if unit != "hour" {
			date = time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC)
		}
		switch unit {
		case "hour", "day":
		case "week":
			date = date.AddDate(0, 0, -(int(date.Weekday())+6)%7)
		case "month":
			date = time.Date(date.Year(), date.Month(), 1, 0, 0, 0, 0, time.UTC)
		default:
			return nil, engineUnavailable("unsupported date bucket unit %q", unit)
		}
		return engineISO(float64(date.UnixMilli())), nil
	case "calendar-week-point":
		timestamp, ok := engineParseDate(values[0])
		reference, referenceOK := engineParseDate(values[1])
		if !ok || !referenceOK {
			return nil, nil
		}
		return engineKey([]any{timestamp, reference, values[2] == true || values[2] == "success"}), nil
	case "failure-streak-point":
		timestamp, ok := engineParseDate(values[0])
		run := engineTrimSpace(engineText(values[1]))
		if !ok || run == "" {
			return nil, nil
		}
		failed, _ := engineNumber(values[2])
		return engineKey([]any{timestamp, run, values[2] == true || failed > 0}), nil
	case "dashboard-link":
		href := engineText(values[1])
		label := engineTrimSpace(engineText(values[2]))
		identity := href
		if len(values) > 3 {
			identity = engineTrimSpace(engineText(values[3]))
		}
		if !strings.HasPrefix(href, "#page-") || label == "" || identity == "" {
			return nil, nil
		}
		out := engineClone(engineMap(values[0]))
		out["dashboard-href"], out["dashboard-label"] = href, label
		return out, nil
	case "link":
		href, label := engineText(values[0]), engineTrimSpace(engineText(values[1]))
		if href == "" || label == "" {
			return nil, nil
		}
		return nativeRow{"href": href, "label": label}, nil
	case "link-href":
		href := engineString(engineMap(values[0])["href"])
		if href == "" {
			return nil, nil
		}
		return href, nil
	case "equals-any":
		for _, value := range values[1:] {
			if engineSame(values[0], value) {
				return true, nil
			}
		}
		return false, nil
	case "if":
		if values[0] == true {
			return values[1], nil
		}
		return values[2], nil
	case "format-count", "format-percent":
		number, ok := engineNumber(values[0])
		if !ok {
			return nil, nil
		}
		if fn == "format-percent" {
			return engineFormatNumber(number*100, 1) + "%", nil
		}
		return engineFormatNumber(number, 3), nil
	case "array-length":
		if !engineArray(values[0]) {
			return nil, nil
		}
		return len(engineList(values[0])), nil
	case "positive-integer":
		number, ok := engineNumber(values[0])
		if ok && math.Trunc(number) == number && number > 0 {
			return number, nil
		}
		fallback, ok := engineNumber(values[1])
		if !ok {
			return nil, nil
		}
		return fallback, nil
	}
	numbers := make([]float64, len(values))
	for i, value := range values {
		n, ok := engineNumber(value)
		if !ok {
			return nil, nil
		}
		numbers[i] = n
	}
	switch fn {
	case "number":
		return numbers[0], nil
	case "greater-than":
		return numbers[0] > numbers[1], nil
	case "sum":
		total := float64(0)
		for _, number := range numbers {
			total += number
		}
		return engineFiniteOrNil(total), nil
	case "difference":
		return engineFiniteOrNil(numbers[0] - numbers[1]), nil
	case "product":
		total := float64(1)
		for _, number := range numbers {
			total *= number
		}
		return engineFiniteOrNil(total), nil
	case "quotient":
		if numbers[1] == 0 {
			return nil, nil
		}
		return engineFiniteOrNil(numbers[0] / numbers[1]), nil
	}
	return nil, engineUnavailable("unsupported computed-field function %q", fn)
}

func engineISO(value float64) string {
	// MaxInt64 rounds up to 2^63 as float64, so the upper bound is exclusive.
	if !engineFinite(value) || value < float64(math.MinInt64) || value >= -float64(math.MinInt64) {
		return ""
	}
	date := time.UnixMilli(int64(value)).UTC()
	text := date.Format("2006-01-02T15:04:05.000Z")
	if date.Year() < 0 || date.Year() > 9999 {
		year := date.Year()
		sign := "+"
		if year < 0 {
			sign, year = "-", -year
		}
		return sign + fmt.Sprintf("%06d", year) + date.Format("-01-02T15:04:05.000Z")
	}
	return text
}

func engineStrictTimestamp(text string) (float64, bool) {
	if !engineTimestamp.MatchString(text) || strings.HasPrefix(text, "0000-") {
		return 0, false
	}
	date, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return 0, false
	}
	return float64(date.UnixMilli()), true
}

func engineFormatNumber(value float64, precision int) string {
	negative := math.Signbit(value)
	value = math.Abs(value)
	scale := math.Pow10(precision)
	value = math.Round(value*scale) / scale
	text := strconv.FormatFloat(value, 'f', precision, 64)
	if strings.Contains(text, ".") {
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	whole, fraction, hasFraction := strings.Cut(text, ".")
	for position := len(whole) - 3; position > 0; position -= 3 {
		whole = whole[:position] + "," + whole[position:]
	}
	if hasFraction {
		whole += "." + fraction
	}
	if negative {
		whole = "-" + whole
	}
	return whole
}

func engineAggregate(rows []nativeRow, aggregate nativeRow, budget *engineBudget) ([]nativeRow, error) {
	fields := engineFields(aggregate["by"])
	groups := map[string][]nativeRow{}
	keys := []string{}
	for i, row := range rows {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		key := engineGroupKey(row, fields, false)
		if _, ok := groups[key]; !ok {
			keys = append(keys, key)
		}
		groups[key] = append(groups[key], row)
	}
	if len(rows) == 0 && len(fields) == 0 {
		keys = append(keys, "[]")
	}
	result := make([]nativeRow, 0, len(keys))
	for i, key := range keys {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		group := groups[key]
		out := nativeRow{}
		if len(group) > 0 {
			for _, field := range fields {
				if value, ok := group[0][field]; ok {
					out[field] = value
				}
			}
		}
		for _, item := range engineList(aggregate["values"]) {
			summary := engineMap(item)
			input := make([]any, 0, len(group))
			filter := engineMap(summary["filter"])
			for _, row := range group {
				if filter == nil || engineMatchesFilter(row, filter) {
					input = append(input, row[engineString(summary["field"])])
				}
			}
			out[engineString(summary["as"])] = engineReduce(input, engineString(summary["reducer"]))
		}
		result = append(result, out)
	}
	return result, nil
}

func engineReduce(input []any, reducer string) any {
	if reducer == "unique" {
		values := map[string]any{}
		for _, value := range input {
			if value != nil {
				values[engineKey(value)] = value
			}
		}
		if len(values) == 1 {
			for _, value := range values {
				return value
			}
		}
		return nil
	}
	present := []any{}
	for _, value := range input {
		if value != nil && value != "" {
			present = append(present, value)
		}
	}
	switch reducer {
	case "count":
		return len(present)
	case "distinct-count", "distinct-list", "distinct-values":
		values := []string{}
		seen := map[string]bool{}
		for _, value := range present {
			text := engineJSString(value)
			if !seen[text] {
				seen[text] = true
				values = append(values, text)
			}
		}
		if reducer == "distinct-count" {
			return len(values)
		}
		sort.Strings(values)
		if reducer == "distinct-list" {
			return strings.Join(values, ", ")
		}
		return values
	case "latest-failure-streak":
		return engineFailureStreak(present)
	case "calendar-week-rhythm":
		return engineCalendarRhythm(present)
	}
	values := []float64{}
	sum := float64(0)
	for _, value := range present {
		numeric := engineJSNumber(value)
		if engineFinite(numeric) {
			values = append(values, numeric)
			sum += numeric
		}
	}
	if reducer == "sum" {
		return engineFiniteOrNil(sum)
	}
	if len(values) == 0 {
		return nil
	}
	if reducer == "mean" {
		return engineFiniteOrNil(sum / float64(len(values)))
	}
	sort.Float64s(values)
	switch reducer {
	case "min":
		return values[0]
	case "max":
		return values[len(values)-1]
	}
	q := map[string]float64{"median": .5, "p75": .75, "p90": .9, "p95": .95}[reducer]
	index := float64(len(values)-1) * q
	lower, upper := int(math.Floor(index)), int(math.Ceil(index))
	return values[lower] + (values[upper]-values[lower])*(index-float64(lower))
}

func engineParsedPoints(input []any, calendar bool) [][]any {
	points := [][]any{}
	for _, value := range input {
		var point []any
		if json.Unmarshal([]byte(engineJSString(value)), &point) != nil || len(point) != 3 {
			continue
		}
		if _, ok := point[0].(float64); !ok {
			continue
		}
		if _, ok := point[2].(bool); !ok {
			continue
		}
		if calendar {
			if _, ok := point[1].(float64); !ok {
				continue
			}
		} else if _, ok := point[1].(string); !ok {
			continue
		}
		points = append(points, point)
	}
	return points
}

func engineFailureStreak(input []any) int {
	points := engineParsedPoints(input, false)
	sort.SliceStable(points, func(i, j int) bool {
		if points[i][0] != points[j][0] {
			return points[i][0].(float64) > points[j][0].(float64)
		}
		left, right := engineJSNumber(points[i][1]), engineJSNumber(points[j][1])
		if engineFinite(left) && engineFinite(right) && left != right {
			return left > right
		}
		return engineLocaleCompare(engineJSString(points[i][1]), engineJSString(points[j][1])) > 0
	})
	seen := map[string]bool{}
	streak := 0
	for _, point := range points {
		run := point[1].(string)
		if seen[run] {
			continue
		}
		seen[run] = true
		if point[2] != true {
			break
		}
		streak++
	}
	return streak
}

func engineCalendarRhythm(input []any) any {
	points := engineParsedPoints(input, true)
	if len(points) == 0 {
		return nil
	}
	day := func(milliseconds float64) time.Time {
		date := time.UnixMilli(int64(milliseconds)).UTC()
		return time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC)
	}
	reference := day(points[0][1].(float64))
	start := reference.AddDate(0, 0, -(int(reference.Weekday())+6)%7)
	counts := map[string]int{}
	for _, point := range points {
		if point[2] == true {
			counts[day(point[0].(float64)).Format("2006-01-02")]++
		}
	}
	days := []nativeRow{}
	for i, label := range []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"} {
		date := start.AddDate(0, 0, i)
		text := date.Format("2006-01-02")
		days = append(days, nativeRow{"label": label, "date": text, "current": counts[text], "previous": counts[date.AddDate(0, 0, -7).Format("2006-01-02")], "reached": !date.After(reference)})
	}
	return nativeRow{"days": days}
}
