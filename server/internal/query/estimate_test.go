package query

import (
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestSnapshotByteEstimationRejectsExcessiveDepth(t *testing.T) {
	var value any = "deep"
	for index := range 40 {
		if index%2 == 0 {
			value = map[string]any{"nested": value}
		} else {
			value = []any{value}
		}
	}
	for _, limit := range []int64{MaxRetainedBytes, 2 << 30} {
		if got := EstimateRowsBytesWithLimit([]model.Row{{"value": value}}, limit); got <= limit {
			t.Fatalf("depth guard did not exceed configured limit: got=%d limit=%d", got, limit)
		}
	}
}

func TestSnapshotByteEstimationDoesNotStopAtHostedBudget(t *testing.T) {
	value := strings.Repeat("x", 1<<20)
	rows := make([]model.Row, 600)
	for index := range rows {
		rows[index] = model.Row{"value": value}
	}
	expected := EstimateRowsBytes(rows[:1]) * int64(len(rows))
	if got := EstimateRowsBytesWithLimit(rows, 2<<30); got != expected || got <= MaxRetainedBytes {
		t.Fatalf("snapshot accounting stopped at hosted ceiling: got=%d want=%d", got, expected)
	}
	if got := EstimateRowsBytes(rows); got >= expected {
		t.Fatalf("hosted bounded accounting changed: got=%d full=%d", got, expected)
	}
}
