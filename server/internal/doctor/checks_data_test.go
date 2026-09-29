package doctor

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestClassifyQueryDefinitionNamesReportsNoDefectsWhenAllNamesAreUniqueAndPresent(t *testing.T) {
	names := classifyQueryDefinitionNames([]query.Definition{
		{Name: "runs", From: "runs"},
		{Name: "repositories", From: "repositories"},
	})
	if len(names.duplicates) != 0 {
		t.Fatalf("duplicates = %v, want none", names.duplicates)
	}
	if len(names.unnamed) != 0 {
		t.Fatalf("unnamed = %v, want none", names.unnamed)
	}
	if names.seen["runs"] != 1 || names.seen["repositories"] != 1 {
		t.Fatalf("seen = %v, want each name counted once", names.seen)
	}
}

func TestClassifyQueryDefinitionNamesReportsEachNameDefinedMoreThanOnce(t *testing.T) {
	names := classifyQueryDefinitionNames([]query.Definition{
		{Name: "runs", From: "runs"},
		{Name: "runs", From: "runs"},
		{Name: "runs", From: "runs"},
		{Name: "repositories", From: "repositories"},
	})
	if got, want := names.duplicates, []string{"runs"}; len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("duplicates = %v, want %v", got, want)
	}
	// A name repeated three times is still one duplicate entry, not one per
	// extra occurrence, because the check reports which names are shadowed
	// rather than how many times each was redefined.
	if names.seen["runs"] != 3 {
		t.Fatalf("seen[\"runs\"] = %d, want 3", names.seen["runs"])
	}
}

func TestClassifyQueryDefinitionNamesReportsDefinitionsWithNoName(t *testing.T) {
	names := classifyQueryDefinitionNames([]query.Definition{
		{Name: "", From: "runs"},
		{Name: "  ", From: "repositories"},
		{Name: "workflows", From: "workflows"},
	})
	if got, want := names.unnamed, []string{"runs", "repositories"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("unnamed = %v, want %v", got, want)
	}
	if len(names.duplicates) != 0 {
		t.Fatalf("duplicates = %v, want none", names.duplicates)
	}
	if names.seen["workflows"] != 1 {
		t.Fatalf("seen[\"workflows\"] = %d, want 1", names.seen["workflows"])
	}
}

func TestClassifyQueryDefinitionNamesSortsDuplicatesForStableOutput(t *testing.T) {
	names := classifyQueryDefinitionNames([]query.Definition{
		{Name: "zeta", From: "z"},
		{Name: "zeta", From: "z"},
		{Name: "alpha", From: "a"},
		{Name: "alpha", From: "a"},
	})
	if got, want := names.duplicates, []string{"alpha", "zeta"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("duplicates = %v, want %v (sorted)", got, want)
	}
}

func TestClassifyQueryDefinitionNamesHandlesEmptyDocument(t *testing.T) {
	names := classifyQueryDefinitionNames(nil)
	if len(names.duplicates) != 0 || len(names.unnamed) != 0 || len(names.seen) != 0 {
		t.Fatalf("names = %+v, want all empty for an empty document", names)
	}
}

func TestClassifyGenerationRetentionReportsOrphansWhenStoredGenerationIsUntracked(t *testing.T) {
	classification := classifyGenerationRetention(
		[]string{"gen-1", "gen-2"}, []string{"gen-1", "gen-2", "gen-orphan"}, "gen-2", 5)
	if classification.status != StatusFail {
		t.Fatalf("status = %v, want %v", classification.status, StatusFail)
	}
	if classification.reason != generationReasonOrphans {
		t.Fatalf("reason = %v, want %v", classification.reason, generationReasonOrphans)
	}
	if got, want := classification.orphans, []string{"gen-orphan"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("orphans = %v, want %v", got, want)
	}
}

func TestClassifyGenerationRetentionExcludesActiveGenerationFromOrphans(t *testing.T) {
	classification := classifyGenerationRetention(
		[]string{"gen-active"}, []string{"gen-active"}, "gen-active", 5)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v (active generation is never an orphan)", classification.status, StatusPass)
	}
}

func TestClassifyGenerationRetentionWarnsWhenTrackedExceedsRetentionAllowance(t *testing.T) {
	tracked := []string{"gen-1", "gen-2", "gen-3", "gen-4"}
	classification := classifyGenerationRetention(tracked, tracked, "gen-4", 1)
	if classification.status != StatusWarn {
		t.Fatalf("status = %v, want %v", classification.status, StatusWarn)
	}
	if classification.reason != generationReasonOverRetention {
		t.Fatalf("reason = %v, want %v", classification.reason, generationReasonOverRetention)
	}
}

func TestClassifyGenerationRetentionToleratesGraceAllowanceOverRetention(t *testing.T) {
	tracked := []string{"gen-1", "gen-2", "gen-3"}
	classification := classifyGenerationRetention(tracked, tracked, "gen-3", 1)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v (within the +2 grace allowance)", classification.status, StatusPass)
	}
}

func TestClassifyGenerationRetentionWarnsWhenActiveGenerationIsUntracked(t *testing.T) {
	classification := classifyGenerationRetention([]string{"gen-1"}, []string{"gen-1", "gen-active"}, "gen-active", 5)
	if classification.status != StatusWarn {
		t.Fatalf("status = %v, want %v", classification.status, StatusWarn)
	}
	if classification.reason != generationReasonActiveUntracked {
		t.Fatalf("reason = %v, want %v", classification.reason, generationReasonActiveUntracked)
	}
}

func TestClassifyGenerationRetentionReportsHealthyWhenWithinRetentionAndTracked(t *testing.T) {
	tracked := []string{"gen-1", "gen-2"}
	classification := classifyGenerationRetention(tracked, tracked, "gen-2", 5)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.reason != generationReasonHealthy {
		t.Fatalf("reason = %v, want %v", classification.reason, generationReasonHealthy)
	}
	if len(classification.orphans) != 0 {
		t.Fatalf("orphans = %v, want none", classification.orphans)
	}
}

func TestClassifyGenerationRetentionHandlesEmptyGenerationSets(t *testing.T) {
	classification := classifyGenerationRetention(nil, nil, "", 5)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.reason != generationReasonHealthy {
		t.Fatalf("reason = %v, want %v", classification.reason, generationReasonHealthy)
	}
}
