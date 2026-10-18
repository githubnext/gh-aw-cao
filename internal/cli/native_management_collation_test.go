package cli

import (
	"sort"
	"strings"
	"testing"
)

func TestNativeManagementEnglishNumericCollationGolden(t *testing.T) {
	// Independently generated with ICU's English collator and
	// UCOL_NUMERIC_COLLATION=UCOL_ON, the backend of production localeCompare.
	tags := []string{}
	for _, stem := range []string{"", "-", ".", "a", "A", "a.", "a-", "aa", "aA", "Aa"} {
		for _, number := range []string{"", "0", "00", "1", "01", "2", "02", "10", "010", "99"} {
			for _, tail := range []string{"", "b", "B", ".", "-", "a0"} {
				prerelease := stem + number + tail
				if prerelease != "" {
					tags = append(tags, "v1.2.3-"+prerelease)
				}
			}
		}
	}
	for _, size := range []int{253, 254, 255, 300} {
		for _, number := range []string{
			strings.Repeat("9", size),
			"1" + strings.Repeat("0", size),
			strings.Repeat("0", 300) + strings.Repeat("9", size),
			strings.Repeat("1", 254) + strings.Repeat("0", size),
			strings.Repeat("1", 254) + strings.Repeat("0", size) + "1",
		} {
			for _, tail := range []string{"", "a", "A", ".1", "-1"} {
				tags = append(tags, "v1.2.3-alpha"+number+tail)
			}
		}
	}
	sort.SliceStable(tags, func(i, j int) bool { return nativeCompareVersions(tags[i], tags[j]) < 0 })
	const expected = "a62cd307daa3517dcc07f511ad08e068bb28be50c32a79dbc76b4e85679c7015"
	if digest := nativeDownloadDigest(strings.Join(tags, "\n") + "\n"); len(tags) != 699 || digest != expected {
		t.Fatalf("699-tag English numeric collation differs from ICU: count=%d sha256=%s", len(tags), digest)
	}
}
