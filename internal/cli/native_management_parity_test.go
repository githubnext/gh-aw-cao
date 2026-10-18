package cli

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestNativeManagementEnglishNumericVersionParity(t *testing.T) {
	// English ICU numeric-collation fixtures match the production
	// localeCompare(..., "en", {numeric: true}) contract without running JS.
	for _, test := range []struct {
		left, right string
		expected    int
	}{
		{"v1.2.3-alpha", "v1.2.3-Alpha", -1},
		{"v1.2.3--99B", "v1.2.3--0-", 1},
		{"v1.2.3-alpha0", "v1.2.3-alpha1", -1},
		{"v1.2.3-alpha2", "v1.2.3-alpha10", -1},
		{"v1.2.3-alpha02", "v1.2.3-alpha2", 0},
		{"v1.2.3-alpha-2", "v1.2.3-alpha.2", -1},
		{"v1.2.3-alpha-2", "v1.2.3-alpha2", -1},
		{"v1.2.3-alpha.2", "v1.2.3-alpha0", -1},
		{"v1.2.3-alpha.2b", "v1.2.3-alpha.2B", -1},
		{"v1.2.3-alpha", "v1.2.3-alpha.", -1},
		{"v1.2.3-alpha2a", "v1.2.3-alpha02A", -1},
		{"v1.2.3-alpha.0", "v1.2.3-alpha.000", 0},
		{"v1.2.3-rc.0001", "v1.2.3-rc.1", 0},
		{"v1.2.3-a0b", "v1.2.3-a00b", 0},
		{"v1.2.3-alpha2Z", "v1.2.3-alpha10a", -1},
		{"v1.2.3", "v1.2.3-rc.999", 1},
		{"v01.02.003-alpha", "v1.2.3-alpha", 0},
		{"v9007199254740992.0.0-alpha", "v9007199254740993.0.0-alpha", 0},
		{"v1.2.3-alpha" + strings.Repeat("9", 253), "v1.2.3-alpha1" + strings.Repeat("0", 253), -1},
		{"v1.2.3-alpha" + strings.Repeat("9", 254), "v1.2.3-alpha1" + strings.Repeat("0", 254), 1},
		{"v1.2.3-alpha" + strings.Repeat("9", 300), "v1.2.3-alpha1" + strings.Repeat("0", 300), 1},
	} {
		t.Run(test.left+"/"+test.right, func(t *testing.T) {
			if got := nativeCompareVersions(test.left, test.right); got != test.expected {
				t.Fatalf("comparison = %d, expected %d", got, test.expected)
			}
			if got := nativeCompareVersions(test.right, test.left); got != -test.expected {
				t.Fatalf("reverse comparison = %d, expected %d", got, -test.expected)
			}
		})
	}
}

func TestNativeManagementPrereleaseSelectionParity(t *testing.T) {
	for _, test := range []struct {
		name, current, releases, expected string
		major                             bool
	}{
		{"numeric", "v1.2.3-alpha.2", "v1.2.3-alpha.10\nv1.2.3-alpha.3", "v1.2.3-alpha.10", false},
		{"English case order", "v1.2.3-alpha", "v1.2.3-Alpha\nv1.2.3-alpha", "v1.2.3-Alpha", false},
		{"equivalent numeric tags retain API order", "v1.2.3-alpha.1", "v1.2.3-alpha.02\nv1.2.3-alpha.2", "v1.2.3-alpha.2", false},
		{"leading zero case order", "v1.2.3-alpha.1", "v1.2.3-alpha02A\nv1.2.3-alpha2a", "v1.2.3-alpha02A", false},
		{"punctuation", "v1.2.3-alpha-1", "v1.2.3-alpha.2\nv1.2.3-alpha-10", "v1.2.3-alpha.2", false},
		{"no downgrade", "v1.2.3-Alpha", "v1.2.3-alpha", "v1.2.3-Alpha", false},
		{"same major only", "v1.2.3-alpha", "v2.0.0-alpha\nv1.3.0-beta", "v1.3.0-beta", false},
		{"explicit major", "v1.2.3-alpha", "v2.0.0-alpha\nv1.3.0-beta", "v2.0.0-alpha", true},
		{"numeric major identity", "v01.2.3-alpha", "v1.3.0-beta", "v1.3.0-beta", false},
		{"stable beats prerelease", "v1.2.3-alpha", "v1.2.3\nv1.2.3-rc.999", "v1.2.3", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			nativeManagementDirectory(t)
			filename := ".github/aw/packages/one.json"
			source := catalogRepository + "/one@" + test.current
			writeTestFile(t, filename, `{"package":"`+catalogRepository+`/one","source":"`+source+`","resolvedCommit":"`+strings.Repeat("e", 40)+`"}`)
			records, err := nativeInstalledPackages()
			if err != nil {
				t.Fatal(err)
			}
			options := nativeUpdateOptions{prereleases: true}
			if test.major {
				options.options = []string{"--major"}
			}
			gh := func(_ context.Context, args ...string) (string, string, error) {
				if !strings.Contains(strings.Join(args, " "), "/releases?per_page=100") {
					t.Fatalf("unexpected release call %q", args)
				}
				return test.releases, "", nil
			}
			prepared, err := nativePrepareRelease(context.Background(), gh, records[0], options, map[string]string{})
			if err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(content), `"source": "`+catalogRepository+"/one@"+test.expected+`"`) {
				t.Fatalf("prepared record selected the wrong tag: %s", content)
			}
			if err := nativeRestorePackage(prepared); err != nil {
				t.Fatal(err)
			}
		})
	}
}
