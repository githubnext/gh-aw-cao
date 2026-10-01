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

func TestClassifyIntegrityDiagnosticsFailsOnRelationshipErrorsBeforeDuplicates(t *testing.T) {
	classification := classifyIntegrityDiagnostics(
		[]string{"run missing repository"},
		map[string][]string{"runs": {"id-1", "id-2"}},
	)
	if classification.status != StatusFail {
		t.Fatalf("status = %v, want %v", classification.status, StatusFail)
	}
	if classification.reason != integrityReasonRelationshipErrors {
		t.Fatalf("reason = %v, want %v", classification.reason, integrityReasonRelationshipErrors)
	}
	if classification.duplicates != 2 {
		t.Fatalf("duplicates = %d, want 2 (duplicates are still counted alongside a relationship failure)", classification.duplicates)
	}
	if got, want := classification.sample, []string{"run missing repository"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("sample = %v, want %v", got, want)
	}
}

func TestClassifyIntegrityDiagnosticsBoundsRelationshipErrorSampleToThree(t *testing.T) {
	classification := classifyIntegrityDiagnostics(
		[]string{"error-1", "error-2", "error-3", "error-4"}, nil)
	if len(classification.sample) != 3 {
		t.Fatalf("sample = %v, want 3 entries (bounded)", classification.sample)
	}
}

func TestClassifyIntegrityDiagnosticsWarnsOnDuplicatesWithoutRelationshipErrors(t *testing.T) {
	classification := classifyIntegrityDiagnostics(
		nil, map[string][]string{"runs": {"id-1"}, "repositories": {"id-2", "id-3"}})
	if classification.status != StatusWarn {
		t.Fatalf("status = %v, want %v", classification.status, StatusWarn)
	}
	if classification.reason != integrityReasonDuplicateRecords {
		t.Fatalf("reason = %v, want %v", classification.reason, integrityReasonDuplicateRecords)
	}
	if classification.duplicates != 3 {
		t.Fatalf("duplicates = %d, want 3 (summed across collections)", classification.duplicates)
	}
	if len(classification.sample) != 0 {
		t.Fatalf("sample = %v, want none (only relationship errors are sampled)", classification.sample)
	}
}

func TestClassifyIntegrityDiagnosticsPassesWhenClean(t *testing.T) {
	classification := classifyIntegrityDiagnostics(nil, nil)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.reason != integrityReasonHealthy {
		t.Fatalf("reason = %v, want %v", classification.reason, integrityReasonHealthy)
	}
	if classification.duplicates != 0 {
		t.Fatalf("duplicates = %d, want 0", classification.duplicates)
	}
}

func TestClassifySourceReadProbeFailsOnReadFailuresBeforeNearLimitWarnings(t *testing.T) {
	classification := classifySourceReadProbe(
		[]string{"runs: connection reset"}, []string{"repositories (900 rows)"}, 5, 400, 1000)
	if classification.status != StatusFail {
		t.Fatalf("status = %v, want %v", classification.status, StatusFail)
	}
	if classification.reason != sourceReadProbeReasonFailures {
		t.Fatalf("reason = %v, want %v", classification.reason, sourceReadProbeReasonFailures)
	}
	if classification.summary != "1 of 5 sources did not read back correctly" {
		t.Fatalf("summary = %q, unexpected", classification.summary)
	}
}

func TestClassifySourceReadProbeWarnsWhenSourceIsNearRowLimit(t *testing.T) {
	classification := classifySourceReadProbe(
		nil, []string{"repositories (900 rows)"}, 5, 2000, 1000)
	if classification.status != StatusWarn {
		t.Fatalf("status = %v, want %v", classification.status, StatusWarn)
	}
	if classification.reason != sourceReadProbeReasonNearLimit {
		t.Fatalf("reason = %v, want %v", classification.reason, sourceReadProbeReasonNearLimit)
	}
}

func TestClassifySourceReadProbePassesWhenAllSourcesReadCleanly(t *testing.T) {
	classification := classifySourceReadProbe(nil, nil, 5, 2000, 1000)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.reason != sourceReadProbeReasonAllReadable {
		t.Fatalf("reason = %v, want %v", classification.reason, sourceReadProbeReasonAllReadable)
	}
	if classification.summary != "all 5 sources read back 2000 rows matching their recorded counts" {
		t.Fatalf("summary = %q, unexpected", classification.summary)
	}
}

func TestClassifySourceReadProbeHandlesNoSources(t *testing.T) {
	classification := classifySourceReadProbe(nil, nil, 0, 0, 1000)
	if classification.status != StatusPass {
		t.Fatalf("status = %v, want %v", classification.status, StatusPass)
	}
	if classification.summary != "all 0 sources read back 0 rows matching their recorded counts" {
		t.Fatalf("summary = %q, unexpected", classification.summary)
	}
}
