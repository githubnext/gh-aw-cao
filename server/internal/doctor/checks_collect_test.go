package doctor

import (
	"errors"
	"os"
	"slices"
	"testing"
)

// fakeLookPath and fakeStat are the injected probes for missingTooling. A
// map keyed by the name/path a real exec.LookPath or os.Stat call would
// receive lets each test describe exactly which dependencies are present
// without touching the real PATH or filesystem.
func fakeLookPath(present map[string]bool) func(string) (string, error) {
	return func(name string) (string, error) {
		if present[name] {
			return "/usr/bin/" + name, nil
		}
		return "", errors.New("not found")
	}
}

func fakeStat(present map[string]bool) func(string) (os.FileInfo, error) {
	return func(path string) (os.FileInfo, error) {
		if present[path] {
			return nil, nil
		}
		return nil, errors.New("not found")
	}
}

func TestMissingToolingReportsNothingWhenEverythingIsAvailable(t *testing.T) {
	lookup := toolingLookup{
		lookPath: fakeLookPath(map[string]bool{"node": true, "gh": true}),
		stat:     fakeStat(map[string]bool{"/catalog/activity/cao.mjs": true}),
	}
	missing := missingTooling(lookup, "node", "gh", "/catalog/activity/cao.mjs")
	if len(missing) != 0 {
		t.Fatalf("expected no missing tooling, got %v", missing)
	}
}

func TestMissingToolingReportsEachAbsentDependency(t *testing.T) {
	lookup := toolingLookup{
		lookPath: fakeLookPath(map[string]bool{}),
		stat:     fakeStat(map[string]bool{}),
	}
	missing := missingTooling(lookup, "node", "gh", "/catalog/activity/cao.mjs")
	want := []string{"node", "gh", "activity/cao.mjs"}
	if !slices.Equal(missing, want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
}

func TestMissingToolingReportsCatalogRootWhenScriptPathIsEmpty(t *testing.T) {
	lookup := toolingLookup{
		lookPath: fakeLookPath(map[string]bool{"node": true, "gh": true}),
		stat:     fakeStat(map[string]bool{}),
	}
	missing := missingTooling(lookup, "node", "gh", "")
	want := []string{"catalog root"}
	if !slices.Equal(missing, want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
}

func TestMissingToolingReportsOnlyTheScriptWhenBinariesArePresent(t *testing.T) {
	lookup := toolingLookup{
		lookPath: fakeLookPath(map[string]bool{"node": true, "gh": true}),
		stat:     fakeStat(map[string]bool{}),
	}
	missing := missingTooling(lookup, "node", "gh", "/catalog/activity/cao.mjs")
	want := []string{"activity/cao.mjs"}
	if !slices.Equal(missing, want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
}

func TestMissingToolingReportsOnlyMissingBinariesWhenScriptIsPresent(t *testing.T) {
	lookup := toolingLookup{
		lookPath: fakeLookPath(map[string]bool{"gh": true}),
		stat:     fakeStat(map[string]bool{"/catalog/activity/cao.mjs": true}),
	}
	missing := missingTooling(lookup, "node", "gh", "/catalog/activity/cao.mjs")
	want := []string{"node"}
	if !slices.Equal(missing, want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
}
