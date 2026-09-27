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

func TestClassifyQueueBacklogReportsDeadLettersBeforeAnythingElse(t *testing.T) {
	// A backlog near the max length must not mask a dead-letter warning; dead
	// letters are checked first regardless of depth.
	classification := classifyQueueBacklog(900, 10, 3, 1000)
	if classification.status != StatusWarn {
		t.Fatalf("status = %v, want %v", classification.status, StatusWarn)
	}
	if classification.reason != queueBacklogReasonDeadLetters {
		t.Fatalf("reason = %v, want %v", classification.reason, queueBacklogReasonDeadLetters)
	}
	if classification.remedy == "" {
		t.Fatal("expected a remedy for dead-lettered tasks")
	}
}

func TestClassifyQueueBacklogWarnsWithinTwentyPercentOfMaxLength(t *testing.T) {
	classification := classifyQueueBacklog(800, 5, 0, 1000)
	if classification.status != StatusWarn {
		t.Fatalf("status = %v, want %v", classification.status, StatusWarn)
	}
	if classification.reason != queueBacklogReasonNearMaxLength {
		t.Fatalf("reason = %v, want %v", classification.reason, queueBacklogReasonNearMaxLength)
	}
}

func TestClassifyQueueBacklogPassesBelowTheWarningThreshold(t *testing.T) {
	classification := classifyQueueBacklog(799, 5, 0, 1000)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.reason != queueBacklogReasonHealthy {
		t.Fatalf("reason = %v, want %v", classification.reason, queueBacklogReasonHealthy)
	}
	if classification.remedy != "" {
		t.Fatalf("expected no remedy for a healthy queue, got %q", classification.remedy)
	}
}

func TestClassifyQueueBacklogPassesWhenNoMaximumIsConfigured(t *testing.T) {
	// maximum <= 0 means unbounded, so the near-max-length threshold must
	// never trigger regardless of depth.
	classification := classifyQueueBacklog(1_000_000, 5, 0, 0)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.reason != queueBacklogReasonHealthy {
		t.Fatalf("reason = %v, want %v", classification.reason, queueBacklogReasonHealthy)
	}
}
