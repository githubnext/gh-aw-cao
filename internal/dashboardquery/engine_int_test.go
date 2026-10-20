package dashboardquery

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"
)

func TestNativeEngineIntegerConversionStringForms(t *testing.T) {
	belowUpper := math.Nextafter(-float64(math.MinInt), 0)
	wantBelowUpper := int(belowUpper)
	for _, test := range []struct {
		name  string
		value any
		want  int
	}{
		{"decimal fraction", "37.5", 37},
		{"negative fraction", "-37.5", -37},
		{"scientific fraction", "3.75e1", 37},
		{"fraction below one", "-9e-1", 0},
		{"negative zero", "-0", 0},
		{"minimum decimal", strconv.FormatInt(int64(math.MinInt), 10), math.MinInt},
		{"below upper decimal", strconv.FormatFloat(belowUpper, 'f', -1, 64), wantBelowUpper},
		{"below upper scientific", strconv.FormatFloat(belowUpper, 'e', -1, 64), wantBelowUpper},
		{"below upper json number", json.Number(strconv.FormatFloat(belowUpper, 'f', -1, 64)), wantBelowUpper},
		{"below upper hex", "0x" + strconv.FormatInt(int64(wantBelowUpper), 16), wantBelowUpper},
		{"below upper octal", "0o" + strconv.FormatInt(int64(wantBelowUpper), 8), wantBelowUpper},
		{"below upper binary", "0b" + strconv.FormatInt(int64(wantBelowUpper), 2), wantBelowUpper},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := engineInt(test.value); got != test.want {
				t.Fatalf("engineInt(%v) = %d, want %d", test.value, got, test.want)
			}
		})
	}
}
