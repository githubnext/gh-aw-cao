package dashboardquery

import (
	"math"
	"sort"
	"strconv"
	"time"
)

func enginePartitions(rows []nativeRow, fields []string) [][]int {
	index := map[string]int{}
	partitions := [][]int{}
	for i, row := range rows {
		key := engineGroupKey(row, fields, true)
		position, ok := index[key]
		if !ok {
			position = len(partitions)
			index[key] = position
			partitions = append(partitions, []int{})
		}
		partitions[position] = append(partitions[position], i)
	}
	return partitions
}

func engineWindow(rows []nativeRow, definitions []any, budget *engineBudget) ([]nativeRow, error) {
	result := make([]nativeRow, len(rows))
	for i, row := range rows {
		result[i] = engineClone(row)
	}
	for _, item := range definitions {
		def := engineMap(item)
		field, as := engineString(def["field"]), engineString(def["as"])
		for _, indices := range enginePartitions(result, engineFields(def["groupby"])) {
			sort.SliceStable(indices, func(i, j int) bool {
				return engineCompareRows(result[indices[i]], result[indices[j]], engineList(def["order-by"]), true) < 0
			})
			for position, index := range indices {
				if position%1024 == 0 {
					if err := budget.spend(0); err != nil {
						return nil, err
					}
				}
				switch def["operation"] {
				case "row-number":
					result[index][as] = position + 1
				case "previous":
					result[index][as] = nil
					if position > 0 {
						result[index][as] = result[indices[position-1]][field]
					}
				case "rolling":
					frame := engineInt(def["frame"])
					start, end := position-frame+1, position+1
					if start < 0 {
						start = 0
					}
					if def["alignment"] == "centered" {
						start, end = position-(frame-1)/2, position+(frame+1)/2
					}
					numbers := []float64{}
					if start >= 0 && end <= len(indices) {
						for _, entry := range indices[start:end] {
							if value, ok := engineNumber(result[entry][field]); ok {
								numbers = append(numbers, value)
							}
						}
					}
					result[index][as] = nil
					if len(numbers) > 0 {
						total := float64(0)
						minimum, maximum := numbers[0], numbers[0]
						for _, value := range numbers {
							total += value
							minimum, maximum = math.Min(minimum, value), math.Max(maximum, value)
						}
						value := total / float64(len(numbers))
						switch def["reducer"] {
						case "sum":
							value = total
						case "min":
							value = minimum
						case "max":
							value = maximum
						}
						result[index][as] = engineFiniteOrNil(value)
					}
				case "change":
					if position == 0 {
						result[index][as] = nil
						continue
					}
					current, currentOK := engineNumber(result[index][field])
					previous, previousOK := engineNumber(result[indices[position-1]][field])
					result[index][as] = nil
					if !currentOK || !previousOK {
						continue
					}
					value := current - previous
					switch def["mode"] {
					case "percentage":
						if previous == 0 {
							continue
						}
						value = 100 * value / previous
					case "rate":
						timeField := engineString(def["time-field"])
						start, startOK := engineWindowTime(result[indices[position-1]][timeField])
						end, endOK := engineWindowTime(result[index][timeField])
						if !startOK || !endOK || end <= start {
							continue
						}
						unit := map[string]float64{"second": 1000, "minute": 60000, "hour": 3600000, "day": 86400000}[engineString(def["unit"])]
						value /= (end - start) / unit
					}
					result[index][as] = engineFiniteOrNil(value)
				}
			}
		}
	}
	return result, nil
}

func engineWindowTime(value any) (float64, bool) {
	text, ok := value.(string)
	if !ok {
		return 0, false
	}
	if len(text) == 10 {
		if date, err := time.Parse("2006-01-02", text); err == nil {
			return float64(date.UnixMilli()), true
		}
		return 0, false
	}
	if !engineTimestamp.MatchString(text) {
		return 0, false
	}
	if _, err := time.Parse("2006-01-02", text[:10]); err != nil {
		return 0, false
	}
	return engineParseDate(text)
}

type engineObservation struct {
	target float64
	values []float64
	weight float64
}

func enginePredict(rows []nativeRow, definitions []any, budget *engineBudget) ([]nativeRow, error) {
	result := make([]nativeRow, len(rows))
	for i, row := range rows {
		result[i] = engineClone(row)
	}
	for _, item := range definitions {
		def := engineMap(item)
		predictors := engineFields(def["on"])
		for _, indices := range enginePartitions(result, engineFields(def["groupby"])) {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
			observations := []engineObservation{}
			for _, index := range indices {
				target, ok := engineNumber(result[index][engineString(def["field"])])
				values, usable := enginePredictionInputs(result[index], predictors)
				if ok && usable {
					observations = append(observations, engineObservation{target: target, values: values, weight: 1})
				}
			}
			model := engineFitPrediction(observations, def)
			for position, index := range indices {
				if position%4096 == 0 {
					if err := budget.spend(0); err != nil {
						return nil, err
					}
				}
				result[index][engineString(def["as"])] = nil
				if values, ok := enginePredictionInputs(result[index], predictors); ok && model != nil {
					result[index][engineString(def["as"])] = engineFiniteOrNil(model(values))
				}
			}
		}
	}
	return result, nil
}

func enginePredictionInputs(row nativeRow, predictors []string) ([]float64, bool) {
	values := make([]float64, len(predictors))
	for i, field := range predictors {
		value, ok := engineNumber(row[field])
		if !ok {
			return nil, false
		}
		values[i] = value
	}
	return values, true
}

func engineFitPrediction(observations []engineObservation, def nativeRow) func([]float64) float64 {
	method := engineString(def["method"])
	design := func(values []float64) []float64 { return append([]float64{1}, values...) }
	evaluate := func(coefficients, values []float64) float64 {
		result := coefficients[0]
		for i, value := range values {
			result += value * coefficients[i+1]
		}
		return result
	}
	switch method {
	case "quad", "poly":
		order := engineDefaultInt(def["order"], 3)
		if method == "quad" {
			order = 2
		}
		center := float64(0)
		for _, observation := range observations {
			center += observation.values[0]
		}
		center /= float64(len(observations))
		scale := float64(1)
		for _, observation := range observations {
			scale = math.Max(scale, math.Abs(observation.values[0]-center))
		}
		design = func(values []float64) []float64 {
			terms := make([]float64, order+1)
			for i := range terms {
				terms[i] = math.Pow((values[0]-center)/scale, float64(i))
			}
			return terms
		}
		evaluate = func(coefficients, values []float64) float64 { return engineDot(coefficients, design(values)) }
	case "log":
		filtered := []engineObservation{}
		for _, observation := range observations {
			if observation.values[0] > 0 {
				filtered = append(filtered, observation)
			}
		}
		observations = filtered
		design = func(values []float64) []float64 { return []float64{1, math.Log(values[0])} }
		evaluate = func(coefficients, values []float64) float64 {
			if values[0] <= 0 {
				return math.NaN()
			}
			return coefficients[0] + coefficients[1]*math.Log(values[0])
		}
	case "exp":
		filtered := []engineObservation{}
		for _, observation := range observations {
			if observation.target > 0 {
				observation.weight, observation.target = observation.target, math.Log(observation.target)
				filtered = append(filtered, observation)
			}
		}
		observations = filtered
		evaluate = func(coefficients, values []float64) float64 {
			return math.Exp(coefficients[0] + coefficients[1]*values[0])
		}
	case "pow":
		filtered := []engineObservation{}
		for _, observation := range observations {
			if observation.target > 0 && observation.values[0] > 0 {
				observation.target = math.Log(observation.target)
				observation.values = []float64{math.Log(observation.values[0])}
				filtered = append(filtered, observation)
			}
		}
		observations = filtered
		evaluate = func(coefficients, values []float64) float64 {
			if values[0] <= 0 {
				return math.NaN()
			}
			return math.Exp(coefficients[0]) * math.Pow(values[0], coefficients[1])
		}
	}
	return engineFitLinear(observations, design, evaluate)
}

func engineDot(left, right []float64) float64 {
	total := float64(0)
	for i, value := range left {
		total += value * right[i]
	}
	return total
}

func engineFitLinear(observations []engineObservation, design func([]float64) []float64, evaluate func([]float64, []float64) float64) func([]float64) float64 {
	if len(observations) == 0 {
		return nil
	}
	matrix := make([][]float64, len(observations))
	targets := make([]float64, len(observations))
	for i, observation := range observations {
		scale := math.Sqrt(observation.weight)
		matrix[i] = design(observation.values)
		for j := range matrix[i] {
			matrix[i][j] *= scale
		}
		targets[i] = observation.target * scale
	}
	columns := len(matrix[0])
	if columns == 0 || len(observations) < columns {
		return nil
	}
	q, r := make([][]float64, columns), make([][]float64, columns)
	for column := 0; column < columns; column++ {
		r[column] = make([]float64, columns)
		vector := make([]float64, len(observations))
		for row := range vector {
			vector[row] = matrix[row][column]
		}
		for previous := 0; previous < column; previous++ {
			r[previous][column] = engineDot(q[previous], vector)
			for row := range vector {
				vector[row] -= r[previous][column] * q[previous][row]
			}
		}
		r[column][column] = math.Sqrt(engineDot(vector, vector))
		if !engineFinite(r[column][column]) || r[column][column] <= math.Nextafter(1, 2)-1 {
			return nil
		}
		q[column] = make([]float64, len(vector))
		for row, value := range vector {
			q[column][row] = value / r[column][column]
		}
	}
	projected := make([]float64, columns)
	for i := range projected {
		projected[i] = engineDot(q[i], targets)
	}
	coefficients := make([]float64, columns)
	for row := columns - 1; row >= 0; row-- {
		known := float64(0)
		for i := row + 1; i < columns; i++ {
			known += r[row][i] * coefficients[i]
		}
		coefficients[row] = (projected[row] - known) / r[row][row]
		if !engineFinite(coefficients[row]) {
			return nil
		}
	}
	return func(values []float64) float64 { return evaluate(coefficients, values) }
}

func engineFacet(rows []nativeRow, def nativeRow, budget *engineBudget) ([]nativeRow, error) {
	panels := []nativeRow{}
	index, rowIndices, columnIndices := map[string]int{}, map[string]int{}, map[string]int{}
	indexOf := func(indices map[string]int, value any) int {
		key := engineKey(value)
		position, ok := indices[key]
		if !ok {
			position = len(indices)
			indices[key] = position
		}
		return position
	}
	for i, row := range rows {
		if i%4096 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		values := make([]any, 3)
		for i, field := range []string{"field", "row", "column"} {
			if name := engineString(def[field]); name != "" {
				values[i] = row[name]
			}
			if !engineIsScalar(values[i]) {
				return nil, engineUnavailable("facet categories must be scalar values")
			}
		}
		key := engineKey(values)
		position, exists := index[key]
		if !exists {
			if len(panels) >= 64 {
				return nil, engineUnavailable("facet result exceeds 64 panels")
			}
			position = len(panels)
			index[key] = position
			panels = append(panels, nativeRow{
				"facet-field": values[0], "facet-row": values[1], "facet-column": values[2],
				"facet-row-index": indexOf(rowIndices, values[1]), "facet-column-index": indexOf(columnIndices, values[2]),
				engineString(def["as"]): []nativeRow{},
			})
		}
		as := engineString(def["as"])
		panels[position][as] = append(panels[position][as].([]nativeRow), row)
	}
	return panels, nil
}

type engineTemporalPoint struct {
	row  nativeRow
	time float64
}

func engineTemporal(rows []nativeRow, def nativeRow, budget *engineBudget) ([]nativeRow, error) {
	result := []nativeRow{}
	groups := []nativeRow{}
	index := map[string]int{}
	groupPoints := [][]engineTemporalPoint{}
	panelSeries := []map[string][]engineTemporalPoint{}
	carry := engineFields(def["carry"])
	shape := engineString(def["shape"])
	grouped := shape == "groups" || shape == "panels"
	timeField, seriesField, linkField := engineString(def["time"]), engineString(def["series"]), engineString(def["link"])
	pointCarry := engineFields(def["point-carry"])
	measures, mappings := engineList(def["measures"]), engineList(def["maps"])
	groupFields := append(append([]string{}, carry...), "metric", "metric-key", "metric-name", "metric-kind", "metric-group")
	count := 0
	appendPoint := func(row, metadata nativeRow, timestamp float64) error {
		if count == engineMaxOutputRows {
			return engineUnavailable("temporal series exceeds the 100000-row output limit")
		}
		ordinal := count
		count++
		if !grouped {
			result = append(result, row)
			return nil
		}
		parts := make([]any, len(carry)+1)
		for i, field := range carry {
			parts[i] = row[field]
		}
		parts[len(carry)] = row["metric-key"]
		key := engineKey(parts)
		position, exists := index[key]
		if !exists {
			position = len(groups)
			index[key] = position
			group := nativeRow{}
			for _, field := range groupFields {
				if value, ok := row[field]; ok {
					group[field] = value
				}
			}
			groups = append(groups, group)
			groupPoints = append(groupPoints, nil)
			panelSeries = append(panelSeries, nil)
			if shape == "panels" {
				panelSeries[position] = map[string][]engineTemporalPoint{}
			}
		}
		point := nativeRow{"x": row["time"], "y": row["value"], "key": engineJSString(row["metric-key"]) + ":" + strconv.Itoa(ordinal)}
		if shape == "groups" {
			point["color"] = row["series"]
			groupPoints[position] = append(groupPoints[position], engineTemporalPoint{row: point, time: timestamp})
		} else {
			if metadata != nil {
				point["metadata"] = metadata
			}
			if value, ok := row["link"]; ok {
				point["link"] = value
			}
			id := engineJSString(row["series"])
			panelSeries[position][id] = append(panelSeries[position][id], engineTemporalPoint{row: point, time: timestamp})
		}
		return nil
	}
	for i, row := range rows {
		if i%1024 == 0 {
			if err := budget.spend(0); err != nil {
				return nil, err
			}
		}
		observed := engineString(row[timeField])
		timestamp, ok := engineParseDate(observed)
		if !ok {
			continue
		}
		base := nativeRow{}
		for _, field := range carry {
			if value, ok := row[field]; ok {
				base[field] = value
			}
		}
		if linkField != "" {
			if value, ok := row[linkField]; ok {
				base["link"] = value
			}
		}
		base["time"], base["series"] = observed, engineText(row[seriesField])
		var metadata nativeRow
		if engineHas(def, "point-carry") {
			metadata = nativeRow{}
			for _, field := range pointCarry {
				if value, ok := row[field]; ok {
					if !engineIsScalar(value) {
						return nil, engineUnavailable("temporal-series point-carry requires scalar fields")
					}
					metadata[field] = value
				}
			}
		}
		for _, item := range measures {
			measure := engineMap(item)
			value := row[engineString(measure["field"])]
			numeric, valid := engineTemporalNumber(value)
			if !valid {
				continue
			}
			field := engineString(measure["field"])
			metric := field
			if key := engineString(measure["key"]); key != "" {
				metric = engineText(row[key])
				if metric == "" {
					metric = field
				}
			}
			out := engineClone(base)
			kind := engineString(measure["kind"])
			out["metric"], out["metric-key"], out["metric-name"], out["metric-kind"], out["metric-group"], out["value"] = metric, kind+":"+metric, metric, kind, metric, numeric
			if err := appendPoint(out, metadata, timestamp); err != nil {
				return nil, err
			}
		}
		for _, item := range mappings {
			mapping := engineMap(item)
			values := engineMap(row[engineString(mapping["field"])])
			names := map[string]string{}
			for _, item := range engineList(row[engineString(mapping["definitions"])]) {
				entry := engineMap(item)
				id, name := engineText(entry["id"]), engineText(entry["name"])
				if name == "" {
					name = id
				}
				if id != "" {
					names[id] = name
				}
			}
			group := engineText(row[engineString(mapping["group"])])
			if group == "" {
				group = engineString(mapping["field"])
			}
			// JSON object iteration is deterministic here, including ECMAScript's
			// numeric-key ordering; Go maps cannot retain original insertion order.
			keys := engineObjectKeys(values)
			if len(keys) > 64 {
				keys = keys[:64]
			}
			for _, metric := range keys {
				numeric, valid := engineTemporalNumber(values[metric])
				if !valid {
					continue
				}
				name := names[metric]
				if name == "" {
					name = metric
				}
				out := engineClone(base)
				kind := engineString(mapping["kind"])
				out["metric"], out["metric-key"], out["metric-name"], out["metric-kind"], out["metric-group"], out["value"] = metric, kind+":"+group+":"+metric, name, kind, group, numeric
				if err := appendPoint(out, metadata, timestamp); err != nil {
					return nil, err
				}
			}
		}
	}
	if !grouped {
		return result, nil
	}
	for i, group := range groups {
		if err := budget.spend(0); err != nil {
			return nil, err
		}
		if shape == "groups" {
			group["points"] = engineOrderedTemporalPoints(groupPoints[i])
			if field := engineString(engineMap(def["trend"])["direction"]); field != "" {
				engineAppendTrend(group, engineText(group[field]))
			}
		} else {
			ids := make([]string, 0, len(panelSeries[i]))
			for id := range panelSeries[i] {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			series := []nativeRow{}
			for _, id := range ids {
				points := engineOrderedTemporalPoints(panelSeries[i][id])
				series = append(series, nativeRow{"id": id, "label": id, "points": points})
			}
			group["series"] = series
		}
	}
	return groups, nil
}

func engineOrderedTemporalPoints(points []engineTemporalPoint) []nativeRow {
	less := func(i, j int) bool { return points[i].time < points[j].time }
	if !sort.SliceIsSorted(points, less) {
		sort.SliceStable(points, less)
	}
	result := make([]nativeRow, len(points))
	for i, point := range points {
		result[i] = point.row
	}
	return result
}

func engineTemporalNumber(value any) (float64, bool) {
	if value == nil || value == "" {
		return 0, false
	}
	numeric := engineJSNumber(value)
	return numeric, engineFinite(numeric)
}

func engineObjectKeys(value nativeRow) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, ae := strconv.ParseUint(keys[i], 10, 32)
		b, be := strconv.ParseUint(keys[j], 10, 32)
		an := ae == nil && a < math.MaxUint32 && strconv.FormatUint(a, 10) == keys[i]
		bn := be == nil && b < math.MaxUint32 && strconv.FormatUint(b, 10) == keys[j]
		if an != bn {
			return an
		}
		if an {
			return a < b
		}
		return keys[i] < keys[j]
	})
	return keys
}

func engineAppendTrend(group nativeRow, preferred string) {
	points := group["points"].([]nativeRow)
	group["trend-observation-count"] = len(points)
	group["trend-assessment"] = "insufficient"
	if len(points) < 2 {
		return
	}
	start, startOK := engineTemporalNumber(points[0]["y"])
	end, endOK := engineTemporalNumber(points[len(points)-1]["y"])
	if !startOK || !endOK {
		return
	}
	delta, direction, assessment := end-start, "flat", "neutral"
	if delta > 0 {
		direction = "up"
	} else if delta < 0 {
		direction = "down"
	}
	switch {
	case direction == "flat":
		assessment = "stable"
	case preferred == "increase" && direction == "up" || preferred == "decrease" && direction == "down":
		assessment = "improving"
	case preferred == "increase" && direction == "down" || preferred == "decrease" && direction == "up":
		assessment = "worsening"
	}
	group["trend-start-value"], group["trend-end-value"], group["trend-delta"] = start, end, delta
	group["trend-relative-percent"] = nil
	if start != 0 {
		group["trend-relative-percent"] = delta / math.Abs(start) * 100
	}
	group["trend-observed-direction"], group["trend-assessment"] = direction, assessment
}
