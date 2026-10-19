package queryengine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestExecuteQueriesProductionRoutingUsesMaterializedSharedDependencies(t *testing.T) {
	content, err := os.ReadFile(filepath.Join(engineTestRoot(t), "dashboard/site/dashboard-fragments/model-routing.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fragment struct {
		Queries []map[string]any `json:"queries"`
	}
	if err := json.Unmarshal(content, &fragment); err != nil {
		t.Fatal(err)
	}
	for i, definition := range fragment.Queries {
		fragment.Queries[i] = engineTestResolveOperands(definition).(map[string]any)
	}
	result, err := ExecuteQueries(t.Context(), fragment.Queries, map[string]any{"audits": []nativeRow{}},
		[]string{"routing-attributed-accounting", "routing-cost-buckets"})
	if err != nil {
		t.Fatal(err)
	}
	for name, source := range result {
		metadata := engineMap(engineMap(source)["metadata"])
		if metadata["availability"] != "empty" {
			t.Fatalf("routing query %s was not evaluated: %#v", name, metadata)
		}
	}
}

func TestExecuteQueriesUncachedLinearDepthRemainsBounded(t *testing.T) {
	definitions := make([]map[string]any, 0, 17)
	input := "input"
	for i := 0; i < 17; i++ {
		name := fmt.Sprintf("step-%d", i)
		definitions = append(definitions, nativeRow{"name": name, "from": input})
		input = name
	}
	if _, err := ExecuteQueries(t.Context(), definitions, map[string]any{"input": []nativeRow{}}, []string{input}); err == nil {
		t.Fatal("uncached dependency path exceeding sixteen query levels was accepted")
	}
}
