package dashboardquery

import (
	"context"
	"strconv"
	"testing"
	"time"
)

func BenchmarkNativeTemporal(b *testing.B) {
	rows := make([]nativeRow, 20000)
	for i := range rows {
		rows[i] = nativeRow{
			"at":   time.Unix(int64(20000-i)*3600, 0).UTC().Format(time.RFC3339),
			"repo": "repo-" + strconv.Itoa(i%8), "value": i, "direction": "increase",
			"metrics": nativeRow{"quality": i % 100},
		}
	}
	for _, shape := range []string{"tidy", "groups", "panels"} {
		b.Run(shape, func(b *testing.B) {
			def := nativeRow{
				"time": "at", "series": "repo", "shape": shape, "carry": []string{"direction"},
				"measures": []nativeRow{{"field": "value", "kind": "primary"}},
				"maps":     []nativeRow{{"field": "metrics", "kind": "diagnostic"}},
			}
			if shape == "groups" {
				def["trend"] = nativeRow{"direction": "direction"}
			}
			b.ReportAllocs()
			for b.Loop() {
				budget := &engineBudget{ctx: b.Context(), deadline: time.Now().Add(time.Minute)}
				result, err := engineTemporal(rows, def, budget)
				if err != nil || len(result) == 0 {
					b.Fatalf("temporal execution: %v", err)
				}
			}
		})
	}
}

func TestNativeTemporalExpandedLimit(t *testing.T) {
	rows := make([]nativeRow, engineMaxOutputRows/2+1)
	for i := range rows {
		rows[i] = nativeRow{"at": "2026-01-01", "repo": "r", "value": i}
	}
	for _, shape := range []string{"tidy", "groups", "panels"} {
		t.Run(shape, func(t *testing.T) {
			def := nativeRow{
				"time": "at", "series": "repo", "shape": shape,
				"measures": []nativeRow{{"field": "value", "kind": "first"}, {"field": "value", "kind": "second"}},
			}
			budget := &engineBudget{ctx: context.Background(), deadline: time.Now().Add(time.Minute)}
			result, err := engineTemporal(rows, def, budget)
			if err == nil || result != nil {
				t.Fatal("expansion must fail closed even when grouped output has only two rows")
			}
		})
	}
}
