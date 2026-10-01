package query

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

var queryLog = logger.New("cao:query")

type Engine struct {
	loader Loader
}

func New(loader Loader) *Engine { return &Engine{loader: loader} }

func ParseDefinitions(data []byte) ([]Definition, error) {
	var definitions []Definition
	if err := json.Unmarshal(data, &definitions); err != nil {
		return nil, fmt.Errorf("parse dashboard queries: %w", err)
	}
	return definitions, Validate(definitions)
}

func Validate(definitions []Definition) error {
	if len(definitions) > 2048 {
		return errors.New("dashboard query batch exceeds 2048 definitions")
	}
	seen := map[string]bool{}
	available := map[string]bool{}
	for _, definition := range definitions {
		if definition.Name == "" || definition.From == "" {
			return errors.New("query name and from are required")
		}
		if seen[definition.Name] {
			return fmt.Errorf("query name %q is declared more than once", definition.Name)
		}
		seen[definition.Name] = true
		if len(definition.Joins) > MaxJoins {
			return fmt.Errorf("query %q exceeds max joins", definition.Name)
		}
		if len(definition.Union) > 64 || len(definition.Compute) > 128 || len(definition.Select) > 256 || len(definition.OrderBy) > 16 {
			return fmt.Errorf("query %q exceeds structural resource limits", definition.Name)
		}
		if err := validateFilter(definition.Filter); err != nil {
			return fmt.Errorf("query %q: %w", definition.Name, err)
		}
		for _, join := range definition.Joins {
			if join.Source == "" || len(join.On) == 0 {
				return fmt.Errorf("query %q contains an unbounded join", definition.Name)
			}
			if join.Type != "" && join.Type != "inner" && join.Type != "left" {
				return fmt.Errorf("query %q has unsupported join type %q", definition.Name, join.Type)
			}
			if seen[join.Source] && !available[join.Source] {
				return fmt.Errorf("query %q has an invalid dependency", definition.Name)
			}
		}
		if definition.Aggregate != nil && (len(definition.Aggregate.Values) == 0 || len(definition.Aggregate.Values) > MaxAggregateValues) {
			return fmt.Errorf("query %q has invalid aggregate values", definition.Name)
		}
		if definition.Aggregate != nil {
			for _, value := range definition.Aggregate.Values {
				if !supportedReducer(value.Reducer) {
					return fmt.Errorf("query %q has unsupported reducer %q", definition.Name, value.Reducer)
				}
				if value.Filter != nil && len(value.Filter.Predicates) > 8 {
					return fmt.Errorf("query %q has too many aggregate filter predicates", definition.Name)
				}
				if err := validateFilter(value.Filter); err != nil {
					return fmt.Errorf("query %q aggregate: %w", definition.Name, err)
				}
			}
		}
		if definition.TemporalSeries != nil &&
			(len(definition.TemporalSeries.Measures) > 64 || len(definition.TemporalSeries.Maps) > 64 || len(definition.TemporalSeries.Carry) > 16) {
			return fmt.Errorf("query %q exceeds temporal-series resource limits", definition.Name)
		}
		if definition.TemporalSeries != nil && definition.TemporalSeries.Shape != "" &&
			definition.TemporalSeries.Shape != "tidy" && definition.TemporalSeries.Shape != "groups" {
			return fmt.Errorf("query %q has unsupported temporal-series shape %q", definition.Name, definition.TemporalSeries.Shape)
		}
		for _, computed := range definition.Compute {
			minimum, maximum, ok := computeArity(computed.Function)
			if !ok {
				return fmt.Errorf("query %q has unsupported computed-field function %q", definition.Name, computed.Function)
			}
			if len(computed.Args) < minimum || len(computed.Args) > maximum {
				return fmt.Errorf("query %q computed field %q has invalid arity", definition.Name, computed.As)
			}
		}
		if len(definition.Predict) > 0 {
			return fmt.Errorf("query %q uses prediction, which is not supported by the dashboard server", definition.Name)
		}

		if definition.Limit != nil && (*definition.Limit <= 0 || *definition.Limit > MaxOutputRows) {
			return fmt.Errorf("query %q has invalid limit", definition.Name)
		}
		available[definition.Name] = true
	}
	names := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		names = append(names, definition.Name)
	}
	if _, err := Dependencies(definitions, names); err != nil {
		return err
	}
	return nil
}

func computeArity(function string) (int, int, bool) {
	arities := map[string][2]int{
		"literal": {1, 1}, "coalesce": {1, 8}, "concat": {1, 8}, "lower": {1, 1}, "upper": {1, 1},
		"title-case": {1, 1}, "trim": {1, 1}, "replace-suffix": {3, 3}, "url-encode": {1, 1},
		"date-day": {1, 1}, "calendar-week-point": {3, 3}, "dashboard-link": {3, 4}, "link-href": {1, 1}, "link": {2, 2},
		"equals-any": {2, 8}, "greater-than": {2, 2}, "if": {3, 3}, "format-count": {1, 1},
		"format-percent": {1, 1}, "array-length": {1, 1}, "failure-streak-point": {3, 3},
		"number": {1, 1}, "positive-integer": {2, 2}, "sum": {2, 8}, "difference": {2, 2},
		"product": {2, 8}, "quotient": {2, 2},
	}
	arity, ok := arities[function]
	return arity[0], arity[1], ok
}

func supportedReducer(reducer string) bool {
	switch reducer {
	case "count", "distinct-count", "distinct-list", "distinct-values", "calendar-week-rhythm",
		"latest-failure-streak", "sum", "mean", "min", "max":
		return true
	default:
		return false
	}
}

func validateFilter(filter *Filter) error {
	if filter == nil {
		return nil
	}
	if len(filter.Predicates) > 64 {
		return errors.New("filter exceeds 64 predicates")
	}
	if filter.Search != nil && len(filter.Search.Fields) > 64 {
		return errors.New("search exceeds 64 fields")
	}
	for _, predicate := range filter.Predicates {
		if len(predicate.In) > MaxPredicateAlternatives {
			return fmt.Errorf("predicate %q exceeds %d alternatives", predicate.Field, MaxPredicateAlternatives)
		}
	}
	return nil
}

func Dependencies(definitions []Definition, requested []string) ([]string, error) {
	order, _, _, err := dependencyPlan(definitions, requested)
	return order, err
}

func dependencyPlan(definitions []Definition, requested []string) ([]string, int, int, error) {
	index := make(map[string]Definition, len(definitions))
	for _, definition := range definitions {
		index[definition.Name] = definition
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var result []string
	maxDepth := 0
	var visit func(string, int) error
	visit = func(name string, depth int) error {
		if depth > MaxDependencyDepth {
			return fmt.Errorf("query dependency graph exceeds max depth of %d", MaxDependencyDepth)
		}
		maxDepth = max(maxDepth, depth)
		if visited[name] {
			return nil
		}
		if visiting[name] {
			return fmt.Errorf("query dependency cycle at %q", name)
		}
		visiting[name] = true
		if definition, ok := index[name]; ok {
			inputs := append([]string{definition.From}, definition.Union...)
			for _, join := range definition.Joins {
				inputs = append(inputs, join.Source)
			}
			for _, input := range inputs {
				if _, isQuery := index[input]; isQuery {
					if err := visit(input, depth+1); err != nil {
						return err
					}
				}
			}
		}
		visiting[name] = false
		visited[name] = true
		result = append(result, name)
		return nil
	}
	for _, name := range requested {
		if err := visit(name, 1); err != nil {
			return nil, 0, 0, err
		}
	}
	depths := map[string]int{}
	joinDepths := map[string]int{}
	maxDepth = 0
	maxJoinDepth := 0
	for _, name := range result {
		definition, isQuery := index[name]
		if !isQuery {
			continue
		}
		depth := 1
		joinDepth := len(definition.Joins)
		inputs := append([]string{definition.From}, definition.Union...)
		for _, join := range definition.Joins {
			inputs = append(inputs, join.Source)
		}
		for _, input := range inputs {
			depth = max(depth, depths[input]+1)
			joinDepth = max(joinDepth, joinDepths[input]+len(definition.Joins))
		}
		depths[name] = depth
		joinDepths[name] = joinDepth
		maxDepth = max(maxDepth, depth)
		maxJoinDepth = max(maxJoinDepth, joinDepth)
	}
	return result, maxDepth, maxJoinDepth, nil
}

func (e *Engine) Execute(definitions []Definition, requested []string) (map[string]model.Source, model.Metrics, error) {
	queryLog.Printf("executing definitions=%d requested=%d", len(definitions), len(requested))
	if err := Validate(definitions); err != nil {
		queryLog.Printf("validation failed")
		return nil, model.Metrics{}, err
	}
	index := make(map[string]*Definition, len(definitions))
	for i := range definitions {
		index[definitions[i].Name] = &definitions[i]
	}
	order, dependencyDepth, dependencyJoins, err := dependencyPlan(definitions, requested)
	if err != nil {
		return nil, model.Metrics{}, err
	}
	queryCount := 0
	for _, name := range order {
		if definition := index[name]; definition != nil {
			queryCount++
		}
	}
	if queryCount > MaxPlanQueries {
		return nil, model.Metrics{}, fmt.Errorf("query plan exceeds max queries of %d", MaxPlanQueries)
	}
	if dependencyJoins > MaxDependencyJoins {
		return nil, model.Metrics{}, fmt.Errorf("query dependency path exceeds max joins of %d", MaxDependencyJoins)
	}
	if executor, ok := e.loader.(PlanExecutor); ok {
		result, metrics, err := executor.ExecutePlan(definitions, requested, order)
		metrics.DependencyDepth = max(metrics.DependencyDepth, dependencyDepth)
		return result, metrics, err
	}
	sources := map[string]model.Source{}
	metrics := model.Metrics{DependencyDepth: dependencyDepth}
	operations := 0
	retainedRows := 0
	var retainedBytes int64
	sourceConsumers := map[string]string{}
	for _, name := range order {
		if definition := index[name]; definition != nil {
			inputs := append([]string{definition.From}, definition.Union...)
			for _, join := range definition.Joins {
				inputs = append(inputs, join.Source)
			}
			for _, input := range inputs {
				if _, isQuery := index[input]; !isQuery && sourceConsumers[input] == "" {
					sourceConsumers[input] = name
				}
			}
		}
	}
	load := func(name string, definition *Definition) error {
		if _, ok := sources[name]; ok {
			return nil
		}
		source, loadedMetrics, err := e.loader.LoadSource(name, definition)
		if err != nil {
			return err
		}
		sourceBytes := estimateRowsBytes(source.Rows, MaxRetainedBytes-retainedBytes)
		if retainedRows+len(source.Rows) > MaxRetainedRows {
			return fmt.Errorf("query plan exceeds max retained rows of %d", MaxRetainedRows)
		}
		if sourceBytes > MaxRetainedBytes-retainedBytes {
			queryID := name
			if definition != nil {
				queryID = definition.Name
			} else if consumer := sourceConsumers[name]; consumer != "" {
				queryID = consumer
			}
			return &PlanLimitError{QueryID: queryID, Boundary: BoundaryRetainedBytes}
		}
		sources[name] = source
		retainedRows += len(source.Rows)
		retainedBytes += sourceBytes
		metrics.RetainedRows = max(metrics.RetainedRows, retainedRows)
		metrics.RetainedBytes = max(metrics.RetainedBytes, retainedBytes)
		mergeMetrics(&metrics, loadedMetrics)
		return nil
	}
	for _, name := range order {
		definition, isQuery := index[name]
		if !isQuery {
			// Raw inputs are loaded by their consumers (or when requested).
			// Preloading here retains a second, unprojected copy of each
			// direct "from" source for the entire query plan.
			continue
		}
		available := make(map[string]model.Source, len(sources)+1)
		for sourceName, source := range sources {
			available[sourceName] = source
		}
		residual := *definition
		if _, derived := index[definition.From]; !derived {
			source, loadedMetrics, err := e.loader.LoadSource(definition.From, definition)
			if err != nil {
				return nil, metrics, err
			}
			mergeMetrics(&metrics, loadedMetrics)
			available[definition.From] = source
			residual = residualDefinition(residual, loadedMetrics.PushedDown)
		}
		for _, input := range definition.Union {
			if _, derived := index[input]; !derived {
				if err := load(input, definition); err != nil {
					return nil, metrics, err
				}
				available[input] = sources[input]
			}
		}
		for _, join := range definition.Joins {
			if _, derived := index[join.Source]; derived {
				continue
			}
			if err := load(join.Source, definition); err != nil {
				var limitErr *PlanLimitError
				if join.Type == "left" && !errors.As(err, &limitErr) {
					available[join.Source] = model.Source{Source: join.Source, Rows: []model.Row{}, Metadata: model.Metadata{"availability": "unavailable"}}
					continue
				}
				return nil, metrics, err
			}
			available[join.Source] = sources[join.Source]
		}
		if canFilterBeforeJoins(residual) {
			inputRows := 0
			for _, input := range append([]string{definition.From}, definition.Union...) {
				inputRows += len(available[input].Rows)
			}
			if inputRows > MaxInputRows {
				return nil, metrics, fmt.Errorf("query %q exceeds max input rows", definition.Name)
			}
			for _, input := range append([]string{definition.From}, definition.Union...) {
				source := available[input]
				// FROM and FILTER both visit the original rows, including those
				// rejected before the rest of the plan executes.
				operations += 2 * len(source.Rows)
				if operations > MaxOperations {
					return nil, metrics, fmt.Errorf("query %q exceeds max operations", definition.Name)
				}
				source.Rows = filterRows(append([]model.Row(nil), source.Rows...), *residual.Filter)
				available[input] = source
			}
			residual.Filter = nil
		}
		workingRows, workingBytes := referencedSize(*definition, available)
		metrics.PeakWorkingRows = max(metrics.PeakWorkingRows, workingRows)
		metrics.PeakWorkingBytes = max(metrics.PeakWorkingBytes, workingBytes)
		if workingRows > MaxWorkingRows {
			return nil, metrics, fmt.Errorf("query %q exceeds max working rows of %d", definition.Name, MaxWorkingRows)
		}
		if workingBytes > MaxWorkingBytes {
			return nil, metrics, fmt.Errorf("query %q exceeds max working bytes of %d", definition.Name, MaxWorkingBytes)
		}
		result, used, fallback, err := ExecuteDefinition(residual, available, MaxOperations-operations)
		operations += used
		metrics.QueryCount++
		metrics.UnionCount += len(definition.Union)
		metrics.JoinCount += len(definition.Joins)
		if definition.Filter != nil {
			metrics.FilterCount++
		}
		metrics.ComputeCount += len(definition.Compute)
		if definition.Aggregate != nil {
			metrics.AggregateCount++
			metrics.AggregateValueCount += len(definition.Aggregate.Values)
		}
		if definition.TemporalSeries != nil {
			metrics.TemporalSeriesCount++
		}
		metrics.SelectCount += len(definition.Select)
		metrics.OrderByCount += len(definition.OrderBy)
		if definition.Limit != nil {
			metrics.LimitCount++
		}
		metrics.FallbackOperations = append(metrics.FallbackOperations, fallback...)
		if err != nil {
			return nil, metrics, err
		}
		resultBytes := estimateRowsBytes(result.Rows, MaxRetainedBytes-retainedBytes)
		if retainedRows+len(result.Rows) > MaxRetainedRows {
			return nil, metrics, fmt.Errorf("query plan exceeds max retained rows of %d", MaxRetainedRows)
		}
		if resultBytes > MaxRetainedBytes-retainedBytes {
			return nil, metrics, &PlanLimitError{QueryID: definition.Name, Boundary: BoundaryRetainedBytes}
		}
		queryLog.Printf("executed query rows=%d operations=%d fallback=%d", len(result.Rows), used, len(fallback))
		sources[name] = result
		retainedRows += len(result.Rows)
		retainedBytes += resultBytes
		metrics.RetainedRows = max(metrics.RetainedRows, retainedRows)
		metrics.RetainedBytes = max(metrics.RetainedBytes, retainedBytes)
	}

	output := make(map[string]model.Source, len(requested))
	for _, name := range requested {
		if source, ok := sources[name]; ok {
			output[name] = source
			continue
		}
		if err := load(name, nil); err != nil {
			return nil, metrics, err
		}
		output[name] = sources[name]
	}
	metrics.Operations = operations
	for _, source := range output {
		metrics.OutputRows += len(source.Rows)
	}
	queryLog.Printf("completed outputs=%d operations=%d", len(output), operations)
	return output, metrics, nil
}

func canFilterBeforeJoins(definition Definition) bool {
	if definition.Filter == nil {
		return false
	}
	for _, join := range definition.Joins {
		if join.Source == definition.From {
			return false
		}
		for _, union := range definition.Union {
			if join.Source == union {
				return false
			}
		}
		for _, field := range join.Fields {
			name := alias(field)
			for _, predicate := range definition.Filter.Predicates {
				if predicate.Field == name || predicate.Field == "@time" &&
					(name == "observed-at" || name == "started-at" || name == "ended-at") {
					return false
				}
			}
			if definition.Filter.Search != nil {
				for _, searchField := range definition.Filter.Search.Fields {
					if searchField == name {
						return false
					}
				}
			}
		}
	}
	return true
}

func referencedSize(definition Definition, sources map[string]model.Source) (int, int64) {
	names := append([]string{definition.From}, definition.Union...)
	for _, join := range definition.Joins {
		names = append(names, join.Source)
	}
	seen := map[string]bool{}
	rows := 0
	var bytes int64
	for _, name := range names {
		if !seen[name] {
			rows += len(sources[name].Rows)
			bytes += estimateRowsBytes(sources[name].Rows, MaxWorkingBytes-bytes)
			seen[name] = true
		}
	}
	return rows, bytes
}

func estimateRowsBytes(rows []model.Row, remaining int64) int64 {
	var total int64
	for _, row := range rows {
		total += 64
		for key, value := range row {
			total += int64(len(key)) + 48 + estimateValueBytes(value, 0)
			if total > remaining {
				return total
			}
		}
	}
	return total
}

// EstimateRowsBytes uses the same accounting as the in-memory evaluator.
// Ingest records this cost so native plans can check the pre-filter input bound.
func EstimateRowsBytes(rows []model.Row) int64 {
	return estimateRowsBytes(rows, MaxRetainedBytes)
}

func estimateValueBytes(value any, depth int) int64 {
	if depth > 32 {
		return MaxWorkingBytes + 1
	}
	switch typed := value.(type) {
	case nil:
		return 0
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return 8
	case string:
		return int64(len(typed))
	case []string:
		total := int64(24)
		for _, item := range typed {
			total += 16 + int64(len(item))
		}
		return total
	case []any:
		total := int64(24)
		for _, item := range typed {
			total += 16 + estimateValueBytes(item, depth+1)
		}
		return total
	case map[string]any:
		total := int64(48)
		for key, item := range typed {
			total += int64(len(key)) + 32 + estimateValueBytes(item, depth+1)
		}
		return total
	default:
		return 32
	}
}

func residualDefinition(definition Definition, pushed []string) Definition {
	contains := func(name string) bool {
		for _, operation := range pushed {
			if operation == name {
				return true
			}
		}
		return false
	}
	if contains("filter") {
		definition.Filter = nil
	}
	if contains("compute") {
		definition.Compute = nil
	}
	if contains("aggregate") {
		definition.Aggregate = nil
	}
	if contains("sort") {
		definition.OrderBy = nil
	}
	if contains("limit") {
		definition.Limit = nil
	}
	return definition
}

func mergeMetrics(target *model.Metrics, incoming model.Metrics) {
	target.PushedDown = append(target.PushedDown, incoming.PushedDown...)
	target.FallbackOperations = append(target.FallbackOperations, incoming.FallbackOperations...)
}

func ExecuteDefinition(definition Definition, sources map[string]model.Source, remaining int) (model.Source, int, []string, error) {
	if len(definition.Predict) > 0 {
		return model.Source{}, 0, nil, errors.New("prediction is not supported by the dashboard server")
	}
	base, ok := sources[definition.From]
	if !ok {
		return model.Source{}, 0, nil, fmt.Errorf("input source %q is unavailable", definition.From)
	}
	if sourceUnavailable(base) {
		return unavailableResult(definition, queryInputCause(definition.From, base)), 0, nil, nil
	}
	rows := cloneRows(base.Rows)
	for _, union := range definition.Union {
		source, exists := sources[union]
		if !exists {
			return model.Source{}, 0, nil, fmt.Errorf("union source %q is unavailable", union)
		}
		if sourceUnavailable(source) {
			return unavailableResult(definition, queryInputCause(union, source)), 0, nil, nil
		}
		rows = append(rows, cloneRows(source.Rows)...)
	}
	if len(rows) > MaxInputRows {
		return model.Source{}, 0, nil, fmt.Errorf("query %q exceeds max input rows", definition.Name)
	}
	operations := len(rows)
	fallback := []string{"from"}
	if operations > remaining {
		return model.Source{}, operations, fallback, fmt.Errorf("query %q exceeds max operations", definition.Name)
	}
	spend := func(cost int) error {
		if cost > remaining-operations {
			operations += cost
			return fmt.Errorf("query %q exceeds max operations", definition.Name)
		}
		operations += cost
		return nil
	}
	for _, join := range definition.Joins {
		source, exists := sources[join.Source]
		if !exists && join.Type != "left" {
			return model.Source{}, operations, fallback, fmt.Errorf("join source %q is unavailable", join.Source)
		}
		var err error
		rows, err = applyJoin(rows, source.Rows, join, &operations, remaining)
		if err != nil {
			return model.Source{}, operations, fallback, err
		}
		fallback = append(fallback, "join")
	}
	if definition.Filter != nil {
		if err := spend(len(rows)); err != nil {
			return model.Source{}, operations, fallback, err
		}
		rows = filterRows(rows, *definition.Filter)
		fallback = append(fallback, "filter")
	}
	if len(definition.Compute) > 0 {
		if err := spend(len(rows) * len(definition.Compute)); err != nil {
			return model.Source{}, operations, fallback, err
		}
		var err error
		rows, err = computeRows(rows, definition.Compute)
		if err != nil {
			return model.Source{}, operations, fallback, err
		}
		fallback = append(fallback, "compute")
	}
	if definition.Aggregate != nil {
		if err := spend(len(rows) * len(definition.Aggregate.Values)); err != nil {
			return model.Source{}, operations, fallback, err
		}
		rows = aggregateRows(rows, *definition.Aggregate)
		fallback = append(fallback, "aggregate")
	}
	if definition.TemporalSeries != nil {
		if err := spend(len(rows)); err != nil {
			return model.Source{}, operations, fallback, err
		}
		var err error
		rows, err = temporalRows(rows, *definition.TemporalSeries)
		if err != nil {
			return model.Source{}, operations, fallback, err
		}
		fallback = append(fallback, "temporal-series")
	}
	if len(definition.Select) > 0 {
		if err := spend(len(rows)); err != nil {
			return model.Source{}, operations, fallback, err
		}
		rows = selectRows(rows, definition.Select)
		fallback = append(fallback, "select")
	}
	if len(definition.OrderBy) > 0 {
		if err := spend(sortCost(len(rows))); err != nil {
			return model.Source{}, operations, fallback, err
		}
		sortRows(rows, definition.OrderBy)
		fallback = append(fallback, "order-by")
	}

	if definition.Limit != nil && len(rows) > *definition.Limit {
		rows = rows[:*definition.Limit]
		fallback = append(fallback, "limit")
	}
	if operations > remaining {
		return model.Source{}, operations, fallback, fmt.Errorf("query %q exceeds max operations", definition.Name)
	}
	if len(rows) > MaxOutputRows {
		return model.Source{}, operations, fallback, fmt.Errorf("query %q exceeds max output rows", definition.Name)
	}
	metadata := model.Metadata{}
	for key, value := range base.Metadata {
		metadata[key] = value
	}
	metadata["source-id"] = definition.Name
	metadata["source-kind"] = "database-query"
	if len(rows) == 0 {
		metadata["availability"] = "empty"
	} else {
		metadata["availability"] = "available"
	}
	metadata["row-count"] = len(rows)
	return model.Source{Source: definition.Name, Rows: rows, Metadata: metadata}, operations, fallback, nil
}

func sortCost(rows int) int {
	if rows < 2 {
		return rows
	}
	return rows * (bits.Len(uint(rows)) - 1)
}

func sourceUnavailable(source model.Source) bool {
	return source.Metadata["availability"] == "unavailable"
}

var querySourceName = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$`)

func queryInputCause(input string, source model.Source) string {
	var code, cause string
	switch upstream := source.Metadata["query-error"].(type) {
	case map[string]string:
		code, cause = upstream["code"], upstream["source"]
	case map[string]any:
		code, _ = upstream["code"].(string)
		cause, _ = upstream["source"].(string)
	}
	if code == "input-unavailable" && len(cause) <= 256 && querySourceName.MatchString(cause) {
		return cause
	}
	return input
}

func unavailableResult(definition Definition, input string) model.Source {
	return model.Source{
		Source: definition.Name,
		Rows:   []model.Row{},
		Metadata: model.Metadata{
			"availability": "unavailable",
			"row-count":    0,
			"query-error":  map[string]string{"code": "input-unavailable", "source": input},
		},
	}
}

func cloneRows(input []model.Row) []model.Row {
	rows := make([]model.Row, len(input))
	for i, row := range input {
		rows[i] = cloneRow(row)
	}
	return rows
}

func cloneRow(input model.Row) model.Row {
	row := make(model.Row, len(input))
	for key, value := range input {
		row[key] = value
	}
	return row
}

func applyJoin(left, right []model.Row, join Join, operations *int, remaining int) ([]model.Row, error) {
	if len(join.On) == 0 {
		return nil, errors.New("join equality keys are required")
	}
	*operations += len(right)
	if *operations > remaining {
		return nil, errors.New("join exceeds max operations")
	}
	index := map[string]model.Row{}
	for _, row := range right {
		key, ok := joinKey(row, join.On, false)
		if !ok {
			continue
		}
		if _, duplicate := index[key]; duplicate {
			return nil, fmt.Errorf("joined source %q contains more than one row per join key", join.Source)
		}
		index[key] = row
	}
	output := make([]model.Row, 0, len(left))
	for _, row := range left {
		key, ok := joinKey(row, join.On, true)
		match, matched := index[key]
		if !ok || !matched {
			if join.Type != "left" {
				continue
			}
			combined := cloneRow(row)
			for _, field := range join.Fields {
				combined[alias(field)] = nil
			}
			output = append(output, combined)
			continue
		}
		combined := cloneRow(row)
		for _, field := range join.Fields {
			combined[alias(field)] = match[field.Field]
		}
		output = append(output, combined)
		if len(output) > MaxJoinRows {
			return nil, errors.New("join exceeds max join rows")
		}
	}
	*operations += len(output)
	if *operations > remaining {
		return nil, errors.New("join exceeds max operations")
	}
	return output, nil
}

func joinKey(row model.Row, keys []JoinKey, left bool) (string, bool) {
	values := make([]string, len(keys))
	for i, key := range keys {
		field := key.Right
		if left {
			field = key.Left
		}
		value := row[field]
		if value == nil {
			return "", false
		}
		switch value.(type) {
		case []any, map[string]any:
			return "", false
		}
		text := strings.TrimSpace(fmt.Sprint(value))
		if text == "" {
			return "", false
		}
		values[i] = text
	}
	data, _ := json.Marshal(values)
	return string(data), true
}

func filterRows(rows []model.Row, filter Filter) []model.Row {
	query := strings.ToLower(strings.TrimSpace(valueOr(filter.Search, func(s *Search) string { return s.Query })))
	output := rows[:0]
	for _, row := range rows {
		searchMatches := query == ""
		if filter.Search != nil {
			for _, field := range filter.Search.Fields {
				if strings.Contains(strings.ToLower(fmt.Sprint(row[field])), query) {
					searchMatches = true
					break
				}
			}
		}
		if searchMatches && predicatesMatch(row, filter.Predicates) {
			output = append(output, row)
		}
	}
	return output
}

func valueOr[T any, R any](value *T, fn func(*T) R) (zero R) {
	if value == nil {
		return zero
	}
	return fn(value)
}

func predicatesMatch(row model.Row, predicates []Predicate) bool {
	for _, predicate := range predicates {
		value := row[predicate.Field]
		if predicate.Field == "@time" {
			found := false
			for _, field := range []string{"observed-at", "started-at", "ended-at"} {
				if row[field] != nil {
					value = row[field]
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if predicate.Optional && empty(value) {
			continue
		}
		if len(predicate.In) > 0 {
			found := false
			for _, candidate := range predicate.In {
				if same(value, candidate) {
					found = true
				}
			}
			if !found {
				return false
			}
			continue
		}
		if predicate.Includes != "" && !strings.Contains(strings.ToLower(fmt.Sprint(value)), strings.ToLower(predicate.Includes)) {
			return false
		}
		if predicate.GTE != nil || predicate.LT != nil {
			if empty(value) {
				return false
			}
			if predicate.GTE != nil && compare(value, predicate.GTE) < 0 {
				return false
			}
			if predicate.LT != nil && compare(value, predicate.LT) >= 0 {
				return false
			}
		}
		if predicate.Includes == "" && predicate.GTE == nil && predicate.LT == nil && !same(value, predicate.Equals) {
			return false
		}
	}
	return true
}

func computeRows(rows []model.Row, fields []ComputedField) ([]model.Row, error) {
	for _, row := range rows {
		for _, field := range fields {
			value, err := computeValue(row, field)
			if err != nil {
				return nil, err
			}
			row[field.As] = value
		}
	}
	return rows, nil
}

func computeValue(row model.Row, definition ComputedField) (any, error) {
	values := make([]any, len(definition.Args))
	for i, argument := range definition.Args {
		if argument.Parameter != "" {
			return nil, fmt.Errorf("unresolved query parameter %q", argument.Parameter)
		}
		if argument.Field != nil {
			values[i] = row[*argument.Field]
		} else {
			values[i] = argument.Value
		}
	}
	switch definition.Function {
	case "literal":
		return scalarValue(values[0]), nil
	case "coalesce":
		for _, value := range values {
			if !empty(value) && scalar(value) {
				return value, nil
			}
		}
		return nil, nil
	case "concat":
		var output strings.Builder
		for _, value := range values {
			if scalar(value) {
				output.WriteString(text(value))
			}
		}
		return output.String(), nil
	case "lower":
		return strings.ToLower(text(values[0])), nil
	case "upper":
		return strings.ToUpper(text(values[0])), nil
	case "title-case":
		parts := strings.FieldsFunc(text(values[0]), func(character rune) bool {
			return character == '-' || character == '_'
		})
		for i, part := range parts {
			if part != "" {
				parts[i] = strings.ToUpper(part[:1]) + part[1:]
			}
		}
		return strings.Join(parts, " "), nil
	case "trim":
		return strings.TrimSpace(text(values[0])), nil
	case "replace-suffix":
		input, suffix := text(values[0]), text(values[1])
		if suffix != "" && strings.HasSuffix(input, suffix) {
			return strings.TrimSuffix(input, suffix) + text(values[2]), nil
		}
		return input, nil
	case "url-encode":
		return strings.ReplaceAll(url.QueryEscape(text(values[0])), "+", "%20"), nil
	case "date-day":
		if instant, ok := timestamp(values[0]); ok {
			return instant.UTC().Format("2006-01-02"), nil
		}
		return nil, nil
	case "calendar-week-point":
		left, okLeft := timestamp(values[0])
		right, okRight := timestamp(values[1])
		if !okLeft || !okRight {
			return nil, nil
		}
		data, _ := json.Marshal([]any{left.UnixMilli(), right.UnixMilli(), values[2] == "success"})
		return string(data), nil
	case "dashboard-link":
		href, label := text(values[1]), strings.TrimSpace(text(values[2]))
		identity := href
		if len(values) == 4 {
			identity = strings.TrimSpace(text(values[3]))
		}
		if !strings.HasPrefix(href, "#page-") || label == "" || identity == "" {
			return nil, nil
		}
		result := model.Row{}
		if existing, ok := values[0].(map[string]any); ok {
			for k, v := range existing {
				result[k] = v
			}
		}
		result["dashboard-href"], result["dashboard-label"] = href, label
		return result, nil
	case "link":
		href, label := text(values[0]), strings.TrimSpace(text(values[1]))
		if href == "" || label == "" {
			return nil, nil
		}
		return model.Row{"href": href, "label": label}, nil
	case "link-href":
		link, ok := values[0].(map[string]any)
		if !ok {
			return nil, nil
		}
		href, ok := link["href"].(string)
		if !ok || href == "" {
			return nil, nil
		}
		return href, nil
	case "equals-any":
		for _, value := range values[1:] {
			if same(values[0], value) {
				return true, nil
			}
		}
		return false, nil
	case "if":
		if values[0] == true {
			return values[1], nil
		}
		return values[2], nil
	case "array-length":
		if array, ok := values[0].([]any); ok {
			return len(array), nil
		}
		return nil, nil
	case "failure-streak-point":
		instant, ok := timestamp(values[0])
		run := strings.TrimSpace(text(values[1]))
		if !ok || run == "" {
			return nil, nil
		}
		failed := values[2] == true
		if number, ok := number(values[2]); ok && number > 0 {
			failed = true
		}
		data, _ := json.Marshal([]any{instant.UnixMilli(), run, failed})
		return string(data), nil
	case "positive-integer":
		if value, ok := number(values[0]); ok && value > 0 && value == math.Trunc(value) {
			return value, nil
		}
		value, _ := number(values[1])
		return value, nil
	case "format-count":
		if value, ok := number(values[0]); ok {
			return formatCount(value), nil
		}
		return nil, nil
	case "format-percent":
		if value, ok := number(values[0]); ok {
			percent := strconv.FormatFloat(math.Round(value*1000)/10, 'f', 1, 64)
			percent = strings.TrimSuffix(percent, ".0")
			return percent + "%", nil
		}
		return nil, nil
	}
	numbers := make([]float64, len(values))
	for i, value := range values {
		var ok bool
		numbers[i], ok = number(value)
		if !ok {
			return nil, nil
		}
	}
	switch definition.Function {
	case "number":
		return numbers[0], nil
	case "greater-than":
		return numbers[0] > numbers[1], nil
	case "sum":
		var sum float64
		for _, value := range numbers {
			sum += value
		}
		return sum, nil
	case "difference":
		return numbers[0] - numbers[1], nil
	case "product":
		product := 1.0
		for _, value := range numbers {
			product *= value
		}
		return product, nil
	case "quotient":
		if numbers[1] == 0 {
			return nil, nil
		}
		return numbers[0] / numbers[1], nil
	default:
		return nil, fmt.Errorf("unsupported computed-field function %q", definition.Function)
	}
}

func aggregateRows(rows []model.Row, aggregate Aggregate) []model.Row {
	groups := map[string][]model.Row{}
	for _, row := range rows {
		values := make([]any, len(aggregate.By))
		for i, field := range aggregate.By {
			values[i] = row[field]
		}
		key, _ := json.Marshal(values)
		groups[string(key)] = append(groups[string(key)], row)
	}
	if len(groups) == 0 && len(aggregate.By) == 0 {
		groups["[]"] = nil
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	output := make([]model.Row, 0, len(groups))
	for _, key := range keys {
		group := groups[key]
		row := model.Row{}
		for _, field := range aggregate.By {
			if len(group) > 0 {
				if value, present := group[0][field]; present {
					row[field] = value
				}
			}
		}
		for _, value := range aggregate.Values {
			contributing := group
			if value.Filter != nil {
				contributing = nil
				for _, candidate := range group {
					if predicatesMatch(candidate, value.Filter.Predicates) {
						contributing = append(contributing, candidate)
					}
				}
			}
			values := make([]any, len(contributing))
			for i, candidate := range contributing {
				values[i] = candidate[value.Field]
			}
			row[value.As] = reduce(values, value.Reducer)
		}
		output = append(output, row)
	}
	return output
}

// distinctValues returns the sorted set of unique string representations of
// values, used by the distinct-count, distinct-list, and distinct-values
// reducers.
func distinctValues(values []any) []string {
	set := map[string]bool{}
	for _, value := range values {
		set[fmt.Sprint(value)] = true
	}
	distinct := make([]string, 0, len(set))
	for value := range set {
		distinct = append(distinct, value)
	}
	sort.Strings(distinct)
	return distinct
}

// numericReduce computes a numeric aggregate reducer ("sum", "mean", "min",
// "max") over already-filtered numbers. It returns ok=false when reducer
// names none of those, so callers can distinguish "no data" (nil result)
// from "unsupported reducer" without duplicating the reducer name switch.
func numericReduce(numbers []float64, reducer string) (any, bool) {
	if reducer == "sum" {
		var sum float64
		for _, value := range numbers {
			sum += value
		}
		return sum, true
	}
	if len(numbers) == 0 {
		return nil, true
	}
	switch reducer {
	case "mean":
		var sum float64
		for _, value := range numbers {
			sum += value
		}
		return sum / float64(len(numbers)), true
	case "min":
		result := numbers[0]
		for _, value := range numbers[1:] {
			if value < result {
				result = value
			}
		}
		return result, true
	case "max":
		result := numbers[0]
		for _, value := range numbers[1:] {
			if value > result {
				result = value
			}
		}
		return result, true
	default:
		return nil, false
	}
}

func reduce(values []any, reducer string) any {
	present := values[:0]
	for _, value := range values {
		if !empty(value) {
			present = append(present, value)
		}
	}
	switch reducer {
	case "count":
		return len(present)
	case "distinct-count", "distinct-list", "distinct-values":
		distinct := distinctValues(present)
		if reducer == "distinct-count" {
			return len(distinct)
		}
		if reducer == "distinct-list" {
			return strings.Join(distinct, ", ")
		}
		return distinct
	case "calendar-week-rhythm":
		return calendarWeekRhythm(present)
	case "latest-failure-streak":
		return latestFailureStreak(present)
	}
	numbers := make([]float64, 0, len(present))
	for _, value := range present {
		if numeric, ok := number(value); ok {
			numbers = append(numbers, numeric)
		}
	}
	result, ok := numericReduce(numbers, reducer)
	if !ok {
		// Validate rejects unsupported reducers before Execute runs, so
		// reaching this path means a reducer bypassed validation.
		queryLog.Printf("unsupported reducer reached aggregation reducer=%q", reducer)
	}
	return result
}

func latestFailureStreak(values []any) int {
	type point struct {
		at     float64
		run    string
		failed bool
	}
	var points []point
	for _, value := range values {
		var raw []any
		if json.Unmarshal([]byte(fmt.Sprint(value)), &raw) == nil && len(raw) == 3 {
			at, ok := number(raw[0])
			if ok {
				points = append(points, point{at: at, run: fmt.Sprint(raw[1]), failed: raw[2] == true})
			}
		}
	}
	sort.SliceStable(points, func(i, j int) bool {
		if points[i].at != points[j].at {
			return points[i].at > points[j].at
		}
		return points[i].run > points[j].run
	})
	seen, streak := map[string]bool{}, 0
	for _, point := range points {
		if seen[point.run] {
			continue
		}
		seen[point.run] = true
		if !point.failed {
			break
		}
		streak++
	}
	return streak
}

func calendarWeekRhythm(values []any) any {
	type point struct {
		at, reference float64
		success       bool
	}
	var points []point
	for _, value := range values {
		var raw []any
		if json.Unmarshal([]byte(fmt.Sprint(value)), &raw) == nil && len(raw) == 3 {
			at, atOK := number(raw[0])
			reference, referenceOK := number(raw[1])
			if atOK && referenceOK {
				points = append(points, point{at, reference, raw[2] == true})
			}
		}
	}
	if len(points) == 0 {
		return nil
	}
	reference := time.UnixMilli(int64(points[0].reference)).UTC()
	day := time.Date(reference.Year(), reference.Month(), reference.Day(), 0, 0, 0, 0, time.UTC)
	start := day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
	counts := map[string]int{}
	for _, point := range points {
		if point.success {
			counts[time.UnixMilli(int64(point.at)).UTC().Format("2006-01-02")]++
		}
	}
	labels := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	days := make([]any, 7)
	for i := range days {
		date := start.AddDate(0, 0, i)
		days[i] = map[string]any{
			"label":    labels[i],
			"date":     date.Format("2006-01-02"),
			"current":  counts[date.Format("2006-01-02")],
			"previous": counts[date.AddDate(0, 0, -7).Format("2006-01-02")],
			"reached":  !date.After(day),
		}
	}
	return map[string]any{"days": days}
}

func temporalRows(rows []model.Row, definition TemporalSeries) ([]model.Row, error) {
	output := []model.Row{}
	for _, row := range rows {
		if _, ok := timestamp(row[definition.Time]); !ok {
			continue
		}
		carried := model.Row{}
		for _, field := range definition.Carry {
			carried[field] = row[field]
		}
		for _, measure := range definition.Measures {
			value, ok := number(row[measure.Field])
			if !ok {
				continue
			}
			metric := measure.Field
			if measure.Key != "" && text(row[measure.Key]) != "" {
				metric = text(row[measure.Key])
			}
			projected := cloneRow(carried)
			projected["time"], projected["series"], projected["metric"] = row[definition.Time], text(row[definition.Series]), metric
			projected["metric-key"], projected["metric-name"], projected["metric-kind"], projected["metric-group"], projected["value"] = measure.Kind+":"+metric, metric, measure.Kind, metric, value
			output = append(output, projected)
		}
		for _, mapping := range definition.Maps {
			values, ok := row[mapping.Field].(map[string]any)
			if !ok {
				continue
			}
			group := mapping.Field
			if mapping.Group != "" && text(row[mapping.Group]) != "" {
				group = text(row[mapping.Group])
			}
			keys := make([]string, 0, len(values))
			for key := range values {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			if len(keys) > 64 {
				keys = keys[:64]
			}
			for _, metric := range keys {
				value, ok := number(values[metric])
				if !ok {
					continue
				}
				projected := cloneRow(carried)
				projected["time"], projected["series"], projected["metric"] = row[definition.Time], text(row[definition.Series]), metric
				projected["metric-key"], projected["metric-name"], projected["metric-kind"], projected["metric-group"], projected["value"] = mapping.Kind+":"+group+":"+metric, metric, mapping.Kind, group, value
				output = append(output, projected)
			}
		}
		if len(output) > MaxOutputRows {
			return nil, errors.New("temporal series exceeds max output rows")
		}
	}
	if definition.Shape != "groups" {
		return output, nil
	}
	groups := map[string]model.Row{}
	for index, row := range output {
		parts := []any{}
		for _, field := range definition.Carry {
			parts = append(parts, row[field])
		}
		parts = append(parts, row["metric-key"])
		data, _ := json.Marshal(parts)
		group := groups[string(data)]
		if group == nil {
			group = model.Row{}
			for _, field := range definition.Carry {
				group[field] = row[field]
			}
			for _, field := range []string{"metric", "metric-key", "metric-name", "metric-kind", "metric-group"} {
				group[field] = row[field]
			}
			group["points"] = []any{}
		}
		group["points"] = append(group["points"].([]any), map[string]any{"x": row["time"], "y": row["value"], "color": row["series"], "key": fmt.Sprintf("%v:%d", row["metric-key"], index)})
		groups[string(data)] = group
	}
	grouped := make([]model.Row, 0, len(groups))
	for _, group := range groups {
		grouped = append(grouped, group)
	}
	return grouped, nil
}

func selectRows(rows []model.Row, fields []SelectedField) []model.Row {
	for i, row := range rows {
		selected := model.Row{}
		for _, field := range fields {
			if value, ok := row[field.Field]; ok {
				selected[alias(field)] = value
			}
		}
		rows[i] = selected
	}
	return rows
}

func alias(field SelectedField) string {
	if field.As != "" {
		return field.As
	}
	return field.Field
}

func sortRows(rows []model.Row, fields []OrderField) {
	sort.SliceStable(rows, func(i, j int) bool {
		for _, field := range fields {
			comparison := compare(rows[i][field.Field], rows[j][field.Field])
			if comparison != 0 {
				if field.Direction == "desc" {
					return comparison > 0
				}
				return comparison < 0
			}
		}
		return false
	})
}

func same(left, right any) bool {
	if left == nil {
		return right == nil || right == "unknown"
	}
	return fmt.Sprint(left) == fmt.Sprint(right)
}

func compare(left, right any) int {
	if same(left, right) {
		return 0
	}
	if empty(left) {
		return 1
	}
	if empty(right) {
		return -1
	}
	if leftTime, ok := timestamp(left); ok {
		if rightTime, rightOK := timestamp(right); rightOK {
			if leftTime.Before(rightTime) {
				return -1
			}
			return 1
		}
	}
	if leftNumber, ok := number(left); ok {
		if rightNumber, rightOK := number(right); rightOK {
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		}
	}
	return strings.Compare(fmt.Sprint(left), fmt.Sprint(right))
}

func number(value any) (float64, bool) {
	if value == nil || value == "" {
		return 0, false
	}
	switch value := value.(type) {
	case bool, map[string]any, []any:
		return 0, false
	case float64:
		return value, !math.IsNaN(value) && !math.IsInf(value, 0)
	case json.Number:
		number, err := value.Float64()
		return number, err == nil
	default:
		number, err := strconv.ParseFloat(fmt.Sprint(value), 64)
		return number, err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
	}
}

func timestamp(value any) (time.Time, bool) {
	text, ok := value.(string)
	if !ok {
		return time.Time{}, false
	}
	instant, err := time.Parse(time.RFC3339Nano, text)
	return instant, err == nil
}

func text(value any) string {
	if scalar(value) && value != nil {
		return fmt.Sprint(value)
	}
	return ""
}

func scalar(value any) bool {
	switch value.(type) {
	case map[string]any, []any:
		return false
	default:
		return true
	}
}

func scalarValue(value any) any {
	if !scalar(value) {
		return nil
	}
	return value
}

func empty(value any) bool { return value == nil || value == "" }

func formatCount(value float64) string {
	text := strconv.FormatFloat(value, 'f', -1, 64)
	parts := strings.SplitN(text, ".", 2)
	integer := parts[0]
	sign := ""
	if strings.HasPrefix(integer, "-") {
		sign, integer = "-", strings.TrimPrefix(integer, "-")
	}
	for index := len(integer) - 3; index > 0; index -= 3 {
		integer = integer[:index] + "," + integer[index:]
	}
	if len(parts) == 2 {
		return sign + integer + "." + parts[1]
	}
	return sign + integer
}
