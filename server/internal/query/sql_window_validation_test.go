package query

import "testing"

func intPtr(value int) *int { return &value }

func TestIsValidWindowOrderBy(t *testing.T) {
	cases := []struct {
		name    string
		orderBy []OrderField
		want    bool
	}{
		{"empty", nil, false},
		{"tooMany", make([]OrderField, 9), false},
		{"blankField", []OrderField{{Field: ""}}, false},
		{"invalidDirection", []OrderField{{Field: "id", Direction: "sideways"}}, false},
		{"noDirection", []OrderField{{Field: "id"}}, true},
		{"ascDirection", []OrderField{{Field: "id", Direction: "asc"}}, true},
		{"descDirection", []OrderField{{Field: "id", Direction: "desc"}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isValidWindowOrderBy(c.orderBy); got != c.want {
				t.Fatalf("isValidWindowOrderBy(%+v) = %v, want %v", c.orderBy, got, c.want)
			}
		})
	}
}

func TestIsValidWindowGroupBy(t *testing.T) {
	cases := []struct {
		name    string
		groupBy []string
		want    bool
	}{
		{"nil", nil, true},
		{"empty", []string{}, false},
		{"tooMany", make([]string, 9), false},
		{"blankField", []string{""}, false},
		{"duplicate", []string{"repo", "repo"}, false},
		{"distinct", []string{"repo", "owner"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isValidWindowGroupBy(c.groupBy); got != c.want {
				t.Fatalf("isValidWindowGroupBy(%v) = %v, want %v", c.groupBy, got, c.want)
			}
		})
	}
}

func TestIsValidRollingWindow(t *testing.T) {
	cases := []struct {
		name  string
		entry WindowField
		want  bool
	}{
		{"missingFrame", WindowField{}, false},
		{"frameTooSmall", WindowField{Frame: intPtr(0)}, false},
		{"frameTooLarge", WindowField{Frame: intPtr(1001)}, false},
		{"validTrailing", WindowField{Frame: intPtr(7), Alignment: "trailing"}, true},
		{"centeredOddFrame", WindowField{Frame: intPtr(5), Alignment: "centered"}, true},
		{"centeredEvenFrame", WindowField{Frame: intPtr(4), Alignment: "centered"}, false},
		{"invalidAlignment", WindowField{Frame: intPtr(3), Alignment: "diagonal"}, false},
		{"invalidReducer", WindowField{Frame: intPtr(3), Reducer: "median"}, false},
		{"validReducer", WindowField{Frame: intPtr(3), Reducer: "sum"}, true},
		{"changeFieldsSet", WindowField{Frame: intPtr(3), Mode: "absolute"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isValidRollingWindow(c.entry); got != c.want {
				t.Fatalf("isValidRollingWindow(%+v) = %v, want %v", c.entry, got, c.want)
			}
		})
	}
}

func TestIsValidChangeWindow(t *testing.T) {
	cases := []struct {
		name  string
		entry WindowField
		want  bool
	}{
		{"defaultAbsolute", WindowField{}, true},
		{"explicitAbsolute", WindowField{Mode: "absolute"}, true},
		{"percentage", WindowField{Mode: "percentage"}, true},
		{"invalidMode", WindowField{Mode: "sideways"}, false},
		{"rollingFieldsSet", WindowField{Frame: intPtr(3)}, false},
		{"rateMissingTimeField", WindowField{Mode: "rate"}, false},
		{"rateMissingUnit", WindowField{Mode: "rate", TimeField: "created-at"}, false},
		{"rateInvalidUnit", WindowField{Mode: "rate", TimeField: "created-at", Unit: "week"}, false},
		{"validRate", WindowField{Mode: "rate", TimeField: "created-at", Unit: "hour"}, true},
		{"nonRateTimeFieldSet", WindowField{TimeField: "created-at"}, false},
		{"nonRateUnitSet", WindowField{Unit: "hour"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isValidChangeWindow(c.entry); got != c.want {
				t.Fatalf("isValidChangeWindow(%+v) = %v, want %v", c.entry, got, c.want)
			}
		})
	}
}

func TestClassifyWindowEntry(t *testing.T) {
	cases := []struct {
		name  string
		entry WindowField
		seed  map[string]bool
		want  windowRejectionStage
	}{
		{
			name:  "blankField",
			entry: WindowField{As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(1)},
			seed:  map[string]bool{},
			want:  windowRejectionStageOutput,
		},
		{
			name:  "duplicateOutput",
			entry: WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(1)},
			seed:  map[string]bool{"out": true},
			want:  windowRejectionStageOutput,
		},
		{
			name:  "invalidOrderBy",
			entry: WindowField{Field: "id", As: "out", Operation: "rolling", Frame: intPtr(1)},
			seed:  map[string]bool{},
			want:  windowRejectionStageOrderBy,
		},
		{
			name:  "invalidGroupBy",
			entry: WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, GroupBy: []string{""}, Operation: "rolling", Frame: intPtr(1)},
			seed:  map[string]bool{},
			want:  windowRejectionStageGroupBy,
		},
		{
			name:  "invalidRolling",
			entry: WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling"},
			seed:  map[string]bool{},
			want:  windowRejectionStageRolling,
		},
		{
			name:  "invalidChange",
			entry: WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "change", Mode: "sideways"},
			seed:  map[string]bool{},
			want:  windowRejectionStageChange,
		},
		{
			name:  "unsupportedOperation",
			entry: WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "cumulative"},
			seed:  map[string]bool{},
			want:  windowRejectionStageOperation,
		},
		{
			name:  "valid",
			entry: WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(3)},
			seed:  map[string]bool{},
			want:  windowRejectionStageNone,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyWindowEntry(c.entry, c.seed); got != c.want {
				t.Fatalf("classifyWindowEntry(%+v) = %v, want %v", c.entry, got, c.want)
			}
		})
	}
	// classifyWindowEntry must record a valid entry's output name so a later
	// duplicate is caught by the next call, matching validateWindows' loop.
	seeded := map[string]bool{}
	first := WindowField{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(3)}
	if got := classifyWindowEntry(first, seeded); got != windowRejectionStageNone {
		t.Fatalf("expected first entry to validate, got %v", got)
	}
	second := WindowField{Field: "other", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(3)}
	if got := classifyWindowEntry(second, seeded); got != windowRejectionStageOutput {
		t.Fatalf("expected duplicate output name to be rejected, got %v", got)
	}
}

func TestValidateWindows(t *testing.T) {
	cases := []struct {
		name    string
		windows []WindowField
		wantErr bool
	}{
		{"empty", nil, true},
		{"tooMany", make([]WindowField, 9), true},
		{
			name: "valid",
			windows: []WindowField{
				{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(3)},
			},
			wantErr: false,
		},
		{
			name: "duplicateOutputAcrossEntries",
			windows: []WindowField{
				{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(3)},
				{Field: "other", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "rolling", Frame: intPtr(3)},
			},
			wantErr: true,
		},
		{
			name: "invalidChangeOperation",
			windows: []WindowField{
				{Field: "id", As: "out", OrderBy: []OrderField{{Field: "id"}}, Operation: "change", Mode: "sideways"},
			},
			wantErr: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateWindows(c.windows)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateWindows(%+v) error = %v, wantErr %v", c.windows, err, c.wantErr)
			}
		})
	}
}
