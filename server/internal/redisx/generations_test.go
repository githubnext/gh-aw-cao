package redisx

import (
	"testing"
	"time"
)

func TestParseTrackedGenerationsDecodesAlternatingEntries(t *testing.T) {
	entries := []string{
		"gen-1", "1000",
		"gen-2", "2000",
	}
	generations := parseTrackedGenerations(entries)
	if len(generations) != 2 {
		t.Fatalf("len(generations) = %d, want 2", len(generations))
	}
	if generations[0].name != "gen-1" || !generations[0].recorded.Equal(time.UnixMilli(1000).UTC()) {
		t.Fatalf("generations[0] = %+v", generations[0])
	}
	if generations[1].name != "gen-2" || !generations[1].recorded.Equal(time.UnixMilli(2000).UTC()) {
		t.Fatalf("generations[1] = %+v", generations[1])
	}
}

func TestParseTrackedGenerationsSkipsBlankMembers(t *testing.T) {
	entries := []string{"", "1000", "gen-1", "2000"}
	generations := parseTrackedGenerations(entries)
	if len(generations) != 1 || generations[0].name != "gen-1" {
		t.Fatalf("generations = %+v, want only gen-1", generations)
	}
}

func TestParseTrackedGenerationsHandlesUnparsableScore(t *testing.T) {
	entries := []string{"gen-1", "not-a-number"}
	generations := parseTrackedGenerations(entries)
	if len(generations) != 1 || generations[0].name != "gen-1" {
		t.Fatalf("generations = %+v, want one entry named gen-1", generations)
	}
	if !generations[0].recorded.Equal(time.UnixMilli(0).UTC()) {
		t.Fatalf("recorded = %v, want the zero-millisecond epoch fallback", generations[0].recorded)
	}
}

func TestParseTrackedGenerationsHandlesEmptyAndOddLengthInput(t *testing.T) {
	if generations := parseTrackedGenerations(nil); len(generations) != 0 {
		t.Fatalf("generations = %+v, want empty", generations)
	}
	if generations := parseTrackedGenerations([]string{"gen-1"}); len(generations) != 0 {
		t.Fatalf("generations = %+v, want empty for a dangling member with no score", generations)
	}
}

func TestReclaimableGenerationsKeepsNewestRetainCount(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	generations := []trackedGeneration{
		{name: "gen-1", recorded: base},
		{name: "gen-2", recorded: base.Add(time.Hour)},
		{name: "gen-3", recorded: base.Add(2 * time.Hour)},
		{name: "gen-4", recorded: base.Add(3 * time.Hour)},
	}
	now := base.Add(24 * time.Hour)
	candidates := reclaimableGenerations(generations, "", 2, time.Minute, now)
	if want := []string{"gen-1", "gen-2"}; !equalStringSlices(candidates, want) {
		t.Fatalf("candidates = %v, want %v", candidates, want)
	}
}

func TestReclaimableGenerationsNeverDropsActiveGeneration(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	generations := []trackedGeneration{
		{name: "gen-1", recorded: base},
		{name: "gen-2", recorded: base.Add(time.Hour)},
	}
	now := base.Add(24 * time.Hour)
	candidates := reclaimableGenerations(generations, "gen-1", 1, time.Minute, now)
	if len(candidates) != 0 {
		t.Fatalf("candidates = %v, want empty because the sole reclamation candidate is active", candidates)
	}
}

func TestReclaimableGenerationsRespectsRetentionGrace(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	generations := []trackedGeneration{
		{name: "gen-1", recorded: base},
		{name: "gen-2", recorded: base.Add(time.Hour)},
	}
	// now is inside the grace period for gen-1, so it must not be reclaimed
	// even though it falls outside the retained count.
	now := base.Add(5 * time.Minute)
	candidates := reclaimableGenerations(generations, "", 1, 10*time.Minute, now)
	if len(candidates) != 0 {
		t.Fatalf("candidates = %v, want empty because gen-1 is still within the retention grace", candidates)
	}
}

func TestReclaimableGenerationsHandlesFewerGenerationsThanRetain(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	generations := []trackedGeneration{{name: "gen-1", recorded: base}}
	candidates := reclaimableGenerations(generations, "", DefaultGenerationRetention, time.Minute, base.Add(24*time.Hour))
	if len(candidates) != 0 {
		t.Fatalf("candidates = %v, want empty when generations are fewer than retain", candidates)
	}
}

func equalStringSlices(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
