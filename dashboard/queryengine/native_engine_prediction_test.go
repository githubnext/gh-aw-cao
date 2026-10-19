package queryengine

import (
	"fmt"
	"testing"
)

func TestNativeEngineLinearPredictionCentersObservations(t *testing.T) {
	for _, method := range []string{"", "linear"} {
		for _, offset := range []float64{0, 1e12} {
			for _, order := range [][]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}} {
				t.Run(fmt.Sprint(method, offset, order), func(t *testing.T) {
					rows := make([]nativeRow, len(order), len(order)+1)
					for i, x := range order {
						rows[i] = nativeRow{"x": offset + float64(x), "y": 2*x + 1}
					}
					rows = append(rows, nativeRow{"x": offset + 3})
					def := engineTestDefinition(t, fmt.Sprintf(`{"predict":[{"method":%q,"on":"x","field":"y","as":"prediction"}],"order-by":[{"field":"x"}]}`, method))
					result := engineTestExecute(t, def, rows)
					for i, row := range result {
						engineTestEqual(t, row["prediction"], 2*i+1)
					}
				})
			}
		}
	}
}

func TestNativeEngineSimpleLinearPredictionRequiresIndependentObservations(t *testing.T) {
	def := engineTestDefinition(t, `{"predict":[{"method":"linear","on":"x","field":"y","as":"prediction"}]}`)
	for _, rows := range [][]nativeRow{
		{{"x": 0, "y": 1}, {"x": 1}},
		{{"x": 1, "y": 1}, {"x": 1, "y": 2}},
	} {
		for _, row := range engineTestExecute(t, def, rows) {
			if row["prediction"] != nil {
				t.Fatalf("underdetermined model produced a prediction: %v", row)
			}
		}
	}
}
