package dashboardquery

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"testing"
)

func TestNativeEngineIntegerConversionBounds(t *testing.T) {
	upper := -float64(math.MinInt)
	belowUpper := math.Nextafter(upper, 0)
	type testCase struct {
		name  string
		value any
		want  int
	}
	tests := []testCase{
		{"zero", 0, 0},
		{"positive fraction", 3.75, 3},
		{"negative fraction", -3.75, -3},
		{"minimum int", math.MinInt, math.MinInt},
		{"below minimum int", math.Nextafter(float64(math.MinInt), math.Inf(-1)), 0},
		{"below upper bound", belowUpper, int(belowUpper)},
		{"upper bound", upper, 0},
		{"maximum uint64", uint64(math.MaxUint64), 0},
		{"hex maximum uint64", "0xffffffffffffffff", 0},
		{"hex above uint64", "0x10000000000000000", 0},
		{"positive infinity", math.Inf(1), 0},
		{"negative infinity", math.Inf(-1), 0},
		{"nan", math.NaN(), 0},
	}
	if strconv.IntSize == 64 {
		tests = append(tests, testCase{"rounded maximum int64", int64(math.MaxInt64), 0})
	} else {
		tests = append(tests, testCase{"maximum int", math.MaxInt, math.MaxInt})
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := engineInt(test.value); got != test.want {
				t.Fatalf("engineInt(%v) = %d, want %d", test.value, got, test.want)
			}
		})
	}
}

func TestNativeEngineISOConversionBounds(t *testing.T) {
	for _, value := range []float64{
		float64(math.MaxInt64),
		float64(math.MaxUint64),
		engineJSNumber("0xffffffffffffffff"),
		math.Nextafter(float64(math.MinInt64), math.Inf(-1)),
		math.MaxFloat64,
		math.Inf(1),
		math.Inf(-1),
		math.NaN(),
	} {
		if got := engineISO(value); got != "" {
			t.Errorf("engineISO(%v) = %q, want empty invalid timestamp", value, got)
		}
	}
	if got := engineISO(0); got != "1970-01-01T00:00:00.000Z" {
		t.Fatalf("engineISO(0) = %q", got)
	}
	for _, test := range []struct {
		value  float64
		prefix string
	}{
		{float64(math.MinInt64), "-292275055-"},
		{math.Nextafter(-float64(math.MinInt64), 0), "+292278994-"},
	} {
		if got := engineISO(test.value); !strings.HasPrefix(got, test.prefix) {
			t.Errorf("engineISO(%v) = %q, want prefix %q", test.value, got, test.prefix)
		}
	}
}

func TestNativeEngineRejectsOverflowingLimits(t *testing.T) {
	for _, value := range []any{uint64(math.MaxUint64), int64(math.MaxInt64), -float64(math.MinInt), math.Inf(1), math.NaN()} {
		called := false
		_, err := executeNativeQuery(context.Background(), nativeRow{"from": "input", "limit": value}, func(string) ([]nativeRow, error) {
			called = true
			return nil, nil
		})
		var unavailable *NativeQueryUnavailableError
		if !errors.As(err, &unavailable) || called {
			t.Errorf("limit %v was not rejected before reading: err=%v called=%v", value, err, called)
		}
	}
}
