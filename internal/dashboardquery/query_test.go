package dashboardquery

import (
	"strings"
	"testing"
)

func TestEvaluatorBoundsIntermediatesWithoutChangingCLIOutputLimit(t *testing.T) {
	rows := make([]map[string]any, engineMaxOutputRows+1)
	for index := range rows {
		rows[index] = map[string]any{"id": index}
	}
	loader := func(string) ([]map[string]any, error) { return rows, nil }
	definition := map[string]any{"name": "intermediate", "from": "input"}
	result, err := NewEvaluator(t.Context()).Execute(definition, loader)
	if err != nil || len(result) != len(rows) {
		t.Fatalf("bounded intermediate was rejected: rows=%d err=%v", len(result), err)
	}
	if _, err := Execute(t.Context(), definition, loader); err == nil || !strings.Contains(err.Error(), "max-output-rows") {
		t.Fatalf("CLI output limit changed: %v", err)
	}
}
