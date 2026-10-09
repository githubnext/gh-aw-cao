package postgres

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestQuotaObservationOutcomeName(t *testing.T) {
	cases := []struct {
		outcome operational.GitHubQuotaObserveOutcome
		want    string
	}{
		{operational.GitHubQuotaObservationStale, "stale"},
		{operational.GitHubQuotaObservationReplaced, "replaced"},
		{operational.GitHubQuotaObservationReconciled, "reconciled"},
		{operational.GitHubQuotaObserveOutcome(99), "stale"},
	}
	for _, c := range cases {
		if got := quotaObservationOutcomeName(c.outcome); got != c.want {
			t.Fatalf("quotaObservationOutcomeName(%v) = %q, want %q", c.outcome, got, c.want)
		}
	}
}

func TestQuotaAdmissionName(t *testing.T) {
	cases := []struct {
		code operational.GitHubQuotaAdmission
		want string
	}{
		{operational.GitHubQuotaAdmitted, "admitted"},
		{operational.GitHubQuotaParked, "parked"},
		{operational.GitHubQuotaExhausted, "exhausted"},
		{operational.GitHubQuotaUnknown, "unknown"},
		{operational.GitHubQuotaDuplicateReservation, "duplicate-reservation"},
		{operational.GitHubQuotaAdmission(99), "unrecognized"},
	}
	for _, c := range cases {
		if got := quotaAdmissionName(c.code); got != c.want {
			t.Fatalf("quotaAdmissionName(%v) = %q, want %q", c.code, got, c.want)
		}
	}
}
