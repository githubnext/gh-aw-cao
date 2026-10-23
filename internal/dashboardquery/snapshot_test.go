package dashboardquery

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"testing"
	"unicode/utf16"
)

func TestDatabaseVersionMatchesCanonicalStorage(t *testing.T) {
	source, err := os.ReadFile("../../dashboard/site/src/data/storage/indexeddb.js")
	if err != nil {
		t.Fatal(err)
	}
	declaration := regexp.MustCompile(`(?m)^export const DATABASE_VERSION = ([0-9]+);$`).FindSubmatch(source)
	if len(declaration) != 2 || string(declaration[1]) != fmt.Sprint(DatabaseVersion) {
		t.Fatalf("Go database version %d must match canonical IndexedDB storage", DatabaseVersion)
	}
}

func TestRecordStringOrderMatchesUTF16(t *testing.T) {
	values := []string{
		"", "a", "aa", "b", "\x00", "\u00e9", "\ud7ff", "\ue000", "\uffff",
		"\U00010000", "\U000103ff", "\U00010400", "\U0010ffff",
		"prefix-\U00010000", "prefix-\ue000", "prefix-\U00010000-tail",
		"\xff", "\xc0", "x\xc2", "x\u00a0",
	}
	for _, left := range values {
		for _, right := range values {
			want := slices.Compare(utf16.Encode([]rune(left)), utf16.Encode([]rune(right)))
			if got := CompareRecordKeys(left, right); got != want {
				t.Fatalf("compare(%q, %q) = %d, want %d", left, right, got, want)
			}
		}
	}
}

func TestRecordStringComparisonDoesNotAllocate(t *testing.T) {
	var order int
	allocations := testing.AllocsPerRun(1000, func() {
		order = compareRecordStrings("repository/workflow/run-\U00010000", "repository/workflow/run-\ue000")
	})
	if order >= 0 || allocations != 0 {
		t.Fatalf("incorrect or allocating UTF-16 comparison: order=%d allocations=%g", order, allocations)
	}
}

func TestDailyRunCountsRejectInvalidAggregateRows(t *testing.T) {
	valid := func() map[string]any {
		return map[string]any{"day": "2026-01-02", "organization": "octo", "repository": "api", "workflow": ".github/workflows/test.md",
			"total": float64(1), "successful": float64(1), "failed": float64(0), "approval": float64(0), "pending": float64(0), "other": float64(0)}
	}
	if err := validateDailyRunCounts(valid()); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		field string
		value any
	}{
		{"total", float64(2)}, {"successful", 0.5}, {"failed", float64(-1)}, {"other", "0"}, {"pending", nil},
		{"day", "2026-02-30"}, {"organization", ""}, {"workflow", nil},
	} {
		row := valid()
		row[test.field] = test.value
		if err := validateDailyRunCounts(row); err == nil {
			t.Fatalf("accepted invalid %s=%v", test.field, test.value)
		}
	}
}
