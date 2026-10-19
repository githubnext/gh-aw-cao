package dashboardquery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type nativeRow = map[string]any

// NativeQueryUnavailableError distinguishes unavailable evidence or an invalid
// declarative plan from a successful query over an empty collection.
type NativeQueryUnavailableError struct {
	Source string
	Reason string
	Cause  error
}

func (e *NativeQueryUnavailableError) Error() string {
	if e.Source != "" {
		return fmt.Sprintf("dashboard query unavailable (%s): %s", e.Source, e.Reason)
	}
	return "dashboard query unavailable: " + e.Reason
}

func (e *NativeQueryUnavailableError) Unwrap() error { return e.Cause }

type NativeQueryCancelledError struct {
	Kind  string
	Cause error
}

func (e *NativeQueryCancelledError) Error() string { return "dashboard query cancelled: " + e.Kind }
func (e *NativeQueryCancelledError) Unwrap() error { return e.Cause }

const (
	engineMaxInputRows  = 200000
	engineMaxOutputRows = 100000
	engineMaxOperations = 5000000
)

type engineBudget struct {
	ctx        context.Context
	deadline   time.Time
	operations int64
	outputRows int
}

func (b *engineBudget) spend(n int64) error {
	b.operations += n
	if err := b.ctx.Err(); err != nil {
		return &NativeQueryCancelledError{Kind: "aborted", Cause: err}
	}
	if time.Now().After(b.deadline) {
		return &NativeQueryCancelledError{Kind: "timeout", Cause: context.DeadlineExceeded}
	}
	if b.operations > engineMaxOperations {
		return &NativeQueryCancelledError{Kind: "budget"}
	}
	return nil
}

func engineUnavailable(format string, args ...any) error {
	return &NativeQueryUnavailableError{Reason: fmt.Sprintf(format, args...)}
}

// executeNativeQuery evaluates one definition. Source resolution (including
// canonical stores and named query dependencies) belongs exclusively to load.
func executeNativeQuery(ctx context.Context, definition map[string]any, load func(string) ([]map[string]any, error)) ([]map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	budget := &engineBudget{ctx: ctx, deadline: time.Now().Add(60 * time.Second)}
	return executeWithBudget(definition, load, budget)
}

func executeWithBudget(definition map[string]any, load func(string) ([]map[string]any, error), budget *engineBudget) ([]map[string]any, error) {
	if err := budget.spend(0); err != nil {
		return nil, err
	}
	if err := engineValidate(definition); err != nil {
		return nil, err
	}
	if load == nil {
		return nil, engineUnavailable("source loader is unavailable")
	}
	read := func(source string, optional bool) ([]nativeRow, error) {
		if err := budget.spend(0); err != nil {
			return nil, err
		}
		rows, err := load(source)
		if err != nil {
			var cancelled *NativeQueryCancelledError
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.As(err, &cancelled) {
				return nil, err
			}
			if optional {
				return []nativeRow{}, nil
			}
			return nil, &NativeQueryUnavailableError{Source: source, Reason: "input source is unavailable", Cause: err}
		}
		if len(rows) > engineMaxInputRows {
			return nil, engineUnavailable("%q exceeds max-input-rows (%d)", source, engineMaxInputRows)
		}
		return rows, budget.spend(0)
	}
	rows, err := read(engineString(definition["from"]), false)
	if err != nil {
		return nil, err
	}
	rows = append([]nativeRow{}, rows...)
	for _, branch := range engineList(definition["union"]) {
		additional, err := read(engineString(branch), true)
		if err != nil {
			return nil, err
		}
		if len(rows)+len(additional) > engineMaxInputRows {
			return nil, engineUnavailable("union exceeds max-input-rows (%d)", engineMaxInputRows)
		}
		rows = append(rows, additional...)
	}
	materializesRows := len(engineList(definition["joins"])) > 0 || len(engineList(definition["compute"])) > 0
	if !materializesRows || len(engineList(definition["union"])) > 0 {
		if err := budget.spend(int64(len(rows))); err != nil {
			return nil, err
		}
	}
	for _, item := range engineList(definition["joins"]) {
		join := engineMap(item)
		right, err := read(engineString(join["source"]), engineString(join["type"]) == "left")
		if err != nil {
			return nil, err
		}
		rows, err = engineJoin(rows, right, join, budget)
		if err != nil {
			return nil, err
		}
	}
	for _, stage := range []string{"filter", "compute", "temporal-series", "aggregate", "predict", "window", "select", "order-by", "limit", "facet"} {
		value, present := definition[stage]
		if !present || value == nil {
			continue
		}
		if (stage == "select" || stage == "order-by") && len(engineList(value)) == 0 {
			continue
		}
		if stage == "compute" && len(engineList(value)) == 0 {
			continue
		}
		if stage == "filter" {
			filter := engineMap(value)
			if len(engineList(filter["predicates"])) == 0 && engineString(engineMap(filter["search"])["query"]) == "" {
				continue
			}
		}
		cost := int64(1)
		switch stage {
		case "aggregate":
			for _, value := range engineList(engineMap(value)["values"]) {
				filter := engineMap(engineMap(value)["filter"])
				if filter == nil {
					continue
				}
				cost++
				for _, predicate := range engineList(filter["predicates"]) {
					cost += 1 + int64(len(engineList(engineMap(predicate)["in"])))
				}
			}
		case "window":
			cost = 0
			for _, item := range engineList(value) {
				window := engineMap(item)
				cost += 33
				if window["operation"] == "rolling" {
					cost += int64(engineInt(window["frame"])) - 1
				}
			}
		case "predict":
			cost = 0
			for _, item := range engineList(value) {
				prediction := engineMap(item)
				terms := len(engineFields(prediction["on"])) + 1
				switch prediction["method"] {
				case "quad":
					terms = 3
				case "poly":
					terms = engineDefaultInt(prediction["order"], 3) + 1
				}
				cost += int64(terms * terms)
			}
		}
		if err := budget.spend(int64(len(rows)) * cost); err != nil {
			return nil, err
		}
		switch stage {
		case "filter":
			rows, err = engineFilter(rows, engineMap(value), budget)
		case "compute":
			rows, err = engineCompute(rows, engineList(value), budget)
		case "aggregate":
			rows, err = engineAggregate(rows, engineMap(value), budget)
		case "select":
			selected := make([]nativeRow, 0, len(rows))
			for i, row := range rows {
				if i%4096 == 0 {
					if err = budget.spend(0); err != nil {
						break
					}
				}
				out := nativeRow{}
				for _, item := range engineList(value) {
					field := engineMap(item)
					name := engineString(field["field"])
					if v, ok := row[name]; ok {
						as := engineString(field["as"])
						if as == "" {
							as = name
						}
						out[as] = v
					}
				}
				selected = append(selected, out)
			}
			rows = selected
		case "order-by":
			rows = append([]nativeRow{}, rows...)
			comparisons := 0
			sort.SliceStable(rows, func(i, j int) bool {
				comparisons++
				if comparisons%4096 == 0 && err == nil {
					err = budget.spend(0)
				}
				return engineCompareRows(rows[i], rows[j], engineList(value), false) < 0
			})
		case "limit":
			if n := engineInt(value); n < len(rows) {
				rows = rows[:n]
			}
		case "window":
			rows, err = engineWindow(rows, engineList(value), budget)
		case "predict":
			rows, err = enginePredict(rows, engineList(value), budget)
		case "temporal-series":
			rows, err = engineTemporal(rows, engineMap(value), budget)
		case "facet":
			rows, err = engineFacet(rows, engineMap(value), budget)
		}
		if err != nil {
			return nil, err
		}
	}
	outputRows := engineMaxOutputRows
	if budget.outputRows > 0 {
		outputRows = budget.outputRows
	}
	if len(rows) > outputRows {
		return nil, engineUnavailable("result exceeds max-output-rows (%d)", outputRows)
	}
	if err := budget.spend(0); err != nil {
		return nil, err
	}
	// Never expose borrowed source maps, even for a raw canonical projection.
	result := make([]nativeRow, len(rows))
	for i, row := range rows {
		result[i] = engineClone(row)
	}
	return result, nil
}

func engineMap(value any) map[string]any {
	m, _ := value.(map[string]any)
	return m
}

func engineList(value any) []any {
	if value == nil {
		return nil
	}
	if values, ok := value.([]any); ok {
		return values
	}
	v := reflect.ValueOf(value)
	if v.Kind() != reflect.Slice && v.Kind() != reflect.Array {
		return nil
	}
	result := make([]any, v.Len())
	for i := range result {
		result[i] = v.Index(i).Interface()
	}
	return result
}

func engineFields(value any) []string {
	if s, ok := value.(string); ok {
		return []string{s}
	}
	result := []string{}
	for _, item := range engineList(value) {
		result = append(result, engineString(item))
	}
	return result
}

func engineString(value any) string {
	s, _ := value.(string)
	return s
}

func engineInt(value any) int {
	n, ok := engineNumber(value)
	// The exclusive upper bound stays exact even when float64 rounds MaxInt up.
	if !ok || n < float64(math.MinInt) || n >= -float64(math.MinInt) {
		return 0
	}
	return int(n)
}
func engineDefaultInt(value any, fallback int) int {
	if value == nil {
		return fallback
	}
	return engineInt(value)
}

func engineClone(row nativeRow) nativeRow {
	out := make(nativeRow, len(row))
	for k, v := range row {
		out[k] = v
	}
	return out
}

func engineKey(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buffer.String(), "\n")
}

func engineFinite(n float64) bool { return !math.IsInf(n, 0) && !math.IsNaN(n) }
func engineFiniteOrNil(n float64) any {
	if engineFinite(n) {
		return n
	}
	return nil
}

// engineNumber is numericValue, not JavaScript Number: booleans, containers,
// null, and the empty string are deliberately not numeric computed inputs.
func engineNumber(value any) (float64, bool) {
	if value == nil {
		return 0, false
	}
	switch v := value.(type) {
	case bool:
		return 0, false
	case string:
		if v == "" {
			return 0, false
		}
		n := engineJSNumber(v)
		return n, engineFinite(n)
	case json.Number:
		n, err := v.Float64()
		return n, err == nil && engineFinite(n)
	}
	v := reflect.ValueOf(value)
	var n float64
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n = float64(v.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n = float64(v.Uint())
	case reflect.Float32, reflect.Float64:
		n = v.Float()
	default:
		return 0, false
	}
	return n, engineFinite(n)
}

func engineJSNumber(value any) float64 {
	if value == nil {
		return 0
	}
	if v, ok := value.(bool); ok {
		if v {
			return 1
		}
		return 0
	}
	if reflect.TypeOf(value).Kind() == reflect.Map {
		return math.NaN()
	}
	text := engineTrimSpace(engineJSString(value))
	if text == "" {
		return 0
	}
	if len(text) > 2 && text[0] == '0' {
		base := 0
		switch text[1] {
		case 'x', 'X':
			base = 16
		case 'b', 'B':
			base = 2
		case 'o', 'O':
			base = 8
		}
		if base != 0 {
			n, err := strconv.ParseUint(text[2:], base, 64)
			if err == nil {
				return float64(n)
			}
			return math.NaN()
		}
	}
	if strings.Contains(text, "_") || strings.EqualFold(text, "nan") || text == "+Inf" || text == "-Inf" || text == "Inf" {
		return math.NaN()
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return math.NaN()
	}
	return n
}

func engineJSString(value any) string {
	if value == nil {
		return "null"
	}
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case json.Number:
		number, err := v.Float64()
		if err != nil {
			return "NaN"
		}
		return engineJSString(number)
	}
	if reflect.TypeOf(value).Kind() == reflect.Map {
		return "[object Object]"
	}
	if values := engineList(value); values != nil {
		parts := make([]string, len(values))
		for i, value := range values {
			if value != nil {
				parts[i] = engineJSString(value)
			}
		}
		return strings.Join(parts, ",")
	}
	n, ok := engineNumber(value)
	if ok {
		if n == 0 {
			return "0"
		}
		if math.Abs(n) >= 1e-6 && math.Abs(n) < 1e21 {
			return strconv.FormatFloat(n, 'f', -1, 64)
		}
		text := strconv.FormatFloat(n, 'e', -1, 64)
		text = strings.ReplaceAll(text, "e-0", "e-")
		text = strings.ReplaceAll(text, "e+0", "e+")
		return text
	}
	return fmt.Sprint(value)
}

func engineText(value any) string {
	if value == nil {
		return ""
	}
	kind := reflect.TypeOf(value).Kind()
	if kind == reflect.Map || kind == reflect.Slice || kind == reflect.Array {
		return ""
	}
	return engineJSString(value)
}

func engineSame(left, right any) bool {
	if left == nil {
		return right == nil || right == "unknown"
	}
	return engineJSString(left) == engineJSString(right)
}

var engineCollators = sync.Pool{New: func() any { return collate.New(language.English) }}

func engineLocaleCompare(left, right string) int {
	collator := engineCollators.Get().(*collate.Collator)
	result := collator.CompareString(left, right)
	engineCollators.Put(collator)
	return result
}

func engineCompare(left, right any) int {
	if reflect.DeepEqual(left, right) {
		return 0
	}
	if left == nil || left == "" {
		return 1
	}
	if right == nil || right == "" {
		return -1
	}
	a := engineJSNumber(strings.ReplaceAll(engineJSString(left), ",", ""))
	b := engineJSNumber(strings.ReplaceAll(engineJSString(right), ",", ""))
	if engineFinite(a) && engineFinite(b) {
		return engineSign(a - b)
	}
	if a, ok := engineParseDate(left); ok {
		if b, ok := engineParseDate(right); ok {
			return engineSign(a - b)
		}
	}
	return engineLocaleCompare(engineJSString(left), engineJSString(right))
}

func engineSign(value float64) int {
	if value < 0 {
		return -1
	}
	if value > 0 {
		return 1
	}
	return 0
}

func engineCompareRows(left, right nativeRow, clauses []any, window bool) int {
	for _, item := range clauses {
		clause := engineMap(item)
		field := engineString(clause["field"])
		a, b := left[field], right[field]
		if window && (a == nil || b == nil) {
			if a == nil && b == nil {
				continue
			}
			if a == nil {
				return 1
			}
			return -1
		}
		comparison := engineCompare(a, b)
		if clause["direction"] == "desc" {
			comparison = -comparison
		}
		if comparison != 0 {
			return comparison
		}
	}
	return 0
}

func engineParseDate(value any) (float64, bool) {
	s, ok := value.(string)
	if !ok || s == "" {
		return 0, false
	}
	s = engineTrimSpace(s)
	if milliseconds, ok := engineParseISODate(s); ok {
		return milliseconds, true
	}
	// V8 Date.parse accepts a bare month or two-digit year in addition to ISO
	// dates. Bounds comparisons use Date.parse before numeric coercion.
	if len(s) <= 2 {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 && !strings.HasPrefix(s, "+") && !strings.HasPrefix(s, "-") {
			year, month := 2001, time.Month(n)
			switch {
			case n == 0:
				year, month = 2000, time.January
			case n >= 1 && n <= 12:
			case n >= 32 && n <= 49:
				year, month = 2000+n, time.January
			case n >= 50:
				year, month = 1900+n, time.January
			default:
				return 0, false
			}
			// Legacy Date.parse forms use the process's local timezone.
			date := time.Date(year, month, 1, 0, 0, 0, 0, time.Local)
			return float64(date.UnixMilli()), true
		}
	}
	if len(s) != 4 && len(s) <= 6 {
		if year, err := strconv.Atoi(s); err == nil && year >= 100 {
			date := time.Date(year, time.January, 1, 0, 0, 0, 0, time.Local)
			return float64(date.UnixMilli()), true
		}
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02", "2006-01", "2006", time.RFC1123, time.RFC1123Z, time.RFC822, "01/02/2006"} {
		location := time.UTC
		if layout == "2006-01-02T15:04:05" || layout == "2006-01-02T15:04" || layout == "01/02/2006" || layout == time.RFC822 {
			location = time.Local
		}
		if t, err := time.ParseInLocation(layout, s, location); err == nil {
			return float64(t.UnixMilli()), true
		}
	}
	return 0, false
}

var engineISODatePattern = regexp.MustCompile(`^([0-9]{4}|[+-][0-9]{6})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$`)

func engineParseISODate(text string) (float64, bool) {
	parts := engineISODatePattern.FindStringSubmatch(text)
	if parts == nil || parts[1] == "-000000" {
		return 0, false
	}
	number := func(index, fallback int) int {
		if parts[index] == "" {
			return fallback
		}
		n, _ := strconv.Atoi(parts[index])
		return n
	}
	year, month, day := number(1, 0), number(2, 1), number(3, 1)
	hour, minute, second := number(4, 0), number(5, 0), number(6, 0)
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 {
		return 0, false
	}
	fraction := parts[7]
	if len(fraction) > 3 {
		fraction = fraction[:3]
	}
	millisecond, _ := strconv.Atoi((fraction + "000")[:3])
	if hour == 24 && (minute != 0 || second != 0 || millisecond != 0) {
		return 0, false
	}
	location := time.UTC
	if parts[4] != "" && parts[8] == "" {
		location = time.Local
	}
	zone := strings.ReplaceAll(parts[8], ":", "")
	if len(zone) == 5 {
		hours, _ := strconv.Atoi(zone[1:3])
		minutes, _ := strconv.Atoi(zone[3:5])
		if hours > 23 || minutes > 59 {
			return 0, false
		}
		offset := (hours*60 + minutes) * 60
		if zone[0] == '-' {
			offset = -offset
		}
		location = time.FixedZone("", offset)
	}
	date := time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), location)
	milliseconds := float64(date.UnixMilli())
	if math.Abs(milliseconds) > 8640000000000000 {
		return 0, false
	}
	return milliseconds, true
}

func engineJoin(rows, right []nativeRow, join nativeRow, budget *engineBudget) ([]nativeRow, error) {
	if err := budget.spend(int64(len(right))); err != nil {
		return nil, err
	}
	key := func(row nativeRow, side string) (string, bool) {
		parts := []string{}
		for _, pair := range engineList(join["on"]) {
			value := row[engineString(engineMap(pair)[side])]
			if value == nil || engineText(value) == "" {
				return "", false
			}
			text := engineTrimSpace(engineText(value))
			if text == "" {
				return "", false
			}
			parts = append(parts, text)
		}
		return engineKey(parts), true
	}
	index := map[string][]nativeRow{}
	for i, row := range right {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		k, valid := key(row, "right")
		if !valid {
			continue
		}
		if len(index[k]) > 0 && join["type"] != "inner-many" {
			return nil, engineUnavailable("joined source %q contains more than one row per join key", join["source"])
		}
		index[k] = append(index[k], row)
	}
	result := []nativeRow{}
	for i, row := range rows {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		k, valid := key(row, "left")
		matches := index[k]
		if !valid {
			matches = nil
		}
		if len(matches) == 0 && join["type"] == "left" {
			matches = []nativeRow{nil}
		}
		for _, match := range matches {
			if len(result) == engineMaxInputRows {
				return nil, engineUnavailable("join exceeds max-join-rows (%d)", engineMaxInputRows)
			}
			if err := budget.spend(1); err != nil {
				return nil, err
			}
			out := engineClone(row)
			for _, item := range engineList(join["fields"]) {
				field := engineMap(item)
				out[engineString(field["as"])] = match[engineString(field["field"])]
			}
			result = append(result, out)
		}
	}
	return result, nil
}

func engineFilter(rows []nativeRow, filter nativeRow, budget *engineBudget) ([]nativeRow, error) {
	result := []nativeRow{}
	for i, row := range rows {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		if engineMatchesFilter(row, filter) {
			result = append(result, row)
		}
	}
	return result, nil
}

func engineMatchesFilter(row, filter nativeRow) bool {
	search := engineMap(filter["search"])
	query := engineLower(engineTrimSpace(engineString(search["query"])))
	if query != "" {
		found := false
		for _, field := range engineFields(search["fields"]) {
			text := ""
			if row[field] != nil {
				text = engineJSString(row[field])
			}
			found = found || strings.Contains(engineLower(text), query)
		}
		if !found {
			return false
		}
	}
	for _, item := range engineList(filter["predicates"]) {
		if !engineMatches(row, engineMap(item)) {
			return false
		}
	}
	return true
}

func engineMatches(row, predicate nativeRow) bool {
	field := engineString(predicate["field"])
	if field == "@time" {
		for _, name := range []string{"observed-at", "started-at", "ended-at"} {
			if _, ok := row[name].(string); !ok {
				continue
			}
			value, ok := engineParseDate(row[name])
			if !ok {
				return true
			}
			start, hasStart := engineParseDate(predicate["gte"])
			end, hasEnd := engineParseDate(predicate["lt"])
			return (!hasStart || value >= start) && (!hasEnd || value < end)
		}
		return true
	}
	value := row[field]
	if predicate["optional"] == true && (value == nil || value == "") {
		return true
	}
	if alternatives, ok := predicate["in"]; ok {
		for _, alternative := range engineList(alternatives) {
			if engineSame(value, alternative) {
				return true
			}
		}
		return false
	}
	if includes, ok := predicate["includes"].(string); ok {
		text := ""
		if value != nil {
			text = engineJSString(value)
		}
		return strings.Contains(engineLower(text), engineLower(includes))
	}
	start, hasStart := predicate["gte"]
	end, hasEnd := predicate["lt"]
	if hasStart || hasEnd {
		if value == nil || value == "" {
			return false
		}
		compare := func(a, b any) int {
			if ad, ok := engineParseDate(a); ok {
				if bd, ok := engineParseDate(b); ok {
					return engineSign(ad - bd)
				}
			}
			if an, ok := engineNumber(a); ok {
				if bn, ok := engineNumber(b); ok {
					return engineSign(an - bn)
				}
			}
			return engineLocaleCompare(engineJSString(a), engineJSString(b))
		}
		return (!hasStart || compare(value, start) >= 0) && (!hasEnd || compare(value, end) < 0)
	}
	return engineSame(value, predicate["equals"])
}

func engineGroupKey(row nativeRow, fields []string, typed bool) string {
	parts := make([]any, len(fields))
	for i, field := range fields {
		value, present := row[field]
		if typed {
			kind := "object"
			if !present {
				kind = "undefined"
			} else if value != nil {
				switch value.(type) {
				case string:
					kind = "string"
				case bool:
					kind = "boolean"
				default:
					if _, ok := engineNumber(value); ok {
						kind = "number"
					}
				}
			}
			parts[i] = []any{kind, value}
		} else {
			parts[i] = value
		}
	}
	return engineKey(parts)
}

func engineIsScalar(value any) bool {
	if value == nil {
		return true
	}
	switch value.(type) {
	case string, bool:
		return true
	}
	_, ok := engineNumber(value)
	return ok
}

func engineTitleCase(s string) string {
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '-' || r == '_' })
	for i, part := range parts {
		runes := []rune(part)
		parts[i] = engineUpper(string(runes[0])) + string(runes[1:])
	}
	return strings.Join(parts, " ")
}

func engineTrimSpace(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return (unicode.IsSpace(r) && r != '\u0085') || r == '\uFEFF'
	})
}

func engineLower(s string) string { return cases.Lower(language.English).String(s) }
func engineUpper(s string) string { return cases.Upper(language.English).String(s) }
