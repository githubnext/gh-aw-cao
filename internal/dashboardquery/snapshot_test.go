package dashboardquery

import (
	"slices"
	"testing"
	"unicode/utf16"
)

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
