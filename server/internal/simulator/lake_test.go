package simulator

import "testing"

func TestValidateLakeRequestRejectsMissingHistory(t *testing.T) {
	if stage := validateLakeRequest(nil, 7, "/tmp/lake"); stage != lakeRequestRejectionStageHistory {
		t.Fatalf("stage = %q, want %q", stage, lakeRequestRejectionStageHistory)
	}
}

func TestValidateLakeRequestRejectsHorizonOutsideHistoryDays(t *testing.T) {
	history := &History{Days: 14}
	cases := map[string]int{"zero": 0, "negative": -1, "beyond-days": 15}
	for name, horizon := range cases {
		t.Run(name, func(t *testing.T) {
			if stage := validateLakeRequest(history, horizon, "/tmp/lake"); stage != lakeRequestRejectionStageHorizon {
				t.Fatalf("stage = %q, want %q", stage, lakeRequestRejectionStageHorizon)
			}
		})
	}
}

func TestValidateLakeRequestRejectsRelativeDirectory(t *testing.T) {
	history := &History{Days: 14}
	if stage := validateLakeRequest(history, 7, "relative/lake"); stage != lakeRequestRejectionStageDirectory {
		t.Fatalf("stage = %q, want %q", stage, lakeRequestRejectionStageDirectory)
	}
}

func TestValidateLakeRequestAcceptsCoveredHorizonAndAbsoluteDirectory(t *testing.T) {
	history := &History{Days: 14}
	if stage := validateLakeRequest(history, 14, "/tmp/lake"); stage != lakeRequestRejectionStageNone {
		t.Fatalf("stage = %q, want %q", stage, lakeRequestRejectionStageNone)
	}
	if stage := validateLakeRequest(history, 1, "/tmp/lake"); stage != lakeRequestRejectionStageNone {
		t.Fatalf("stage = %q, want %q", stage, lakeRequestRejectionStageNone)
	}
}

func TestWriteLakeRejectsUncoveredHorizonWithoutTouchingDisk(t *testing.T) {
	scenario := Scenario{
		Name: "lake", Repositories: 1,
		History: &History{Days: 7, RunsPerDay: 1, AsOf: "2026-10-01T12:00:00Z"},
	}
	directory := t.TempDir()
	if _, err := scenario.WriteLake(t.Context(), directory, 30); err == nil {
		t.Fatal("expected an error for a horizon beyond History.Days")
	}
}
