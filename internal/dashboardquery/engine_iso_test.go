package dashboardquery

import (
	"math"
	"testing"
	"time"
)

func TestNativeEngineISOConversionMilliseconds(t *testing.T) {
	tests := []struct {
		name         string
		value        float64
		milliseconds int64
	}{
		{"minimum", float64(math.MinInt64), math.MinInt64},
		{"above minimum", math.Nextafter(float64(math.MinInt64), 0), math.MinInt64 + 1024},
		{"below upper bound", math.Nextafter(-float64(math.MinInt64), 0), math.MaxInt64 - 1023},
		{"negative whole second", -1000, -1000},
		{"negative fractional second", -1000.75, -1000},
		{"negative fractional milliseconds", -999.75, -999},
		{"negative millisecond", -1, -1},
		{"negative fraction", -1.75, -1},
		{"negative submillisecond", -0.75, 0},
		{"negative zero", math.Copysign(0, -1), 0},
		{"zero", 0, 0},
		{"positive submillisecond", 0.75, 0},
		{"positive fraction", 1.75, 1},
		{"positive fractional milliseconds", 999.75, 999},
		{"positive fractional second", 1000.75, 1000},
		{"positive whole second", 1000, 1000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			want := time.UnixMilli(test.milliseconds).UTC().Format("2006-01-02T15:04:05.000Z")
			if test.milliseconds > 253402300799999 {
				want = "+" + want
			}
			if got := engineISO(test.value); got != want {
				t.Errorf("engineISO(%v) = %q, want %q", test.value, got, want)
			}
		})
	}
}
