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
