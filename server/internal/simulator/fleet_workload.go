package simulator

import (
	"fmt"
	"time"
)

type FleetPullRequest struct {
	ID         string
	Repository FleetRepository
	Developer  int
	Number     int
	ReadyAt    time.Time
}

// FleetDay produces exactly 10 PRs/developer/day at p50, with a reproducible
// 2/6/10/14/18 distribution. Ten percent arrive in one burst at minute 600;
// the rest span the day. All PRs start as drafts, then become ready.
func FleetDay(start time.Time, day, developers int, active []FleetRepository) []FleetPullRequest {
	if developers < 1 || developers%5 != 0 || len(active) == 0 {
		panic("fleet workload requires a positive multiple of five developers and active repositories")
	}
	result := make([]FleetPullRequest, 0, developers*10)
	ordinal := 0
	for developer := range developers {
		count := [...]int{2, 6, 10, 14, 18}[developer%5]
		for pr := range count {
			// A permutation over the minute slots spreads normal traffic while
			// preserving a large, exactly reproducible correlated arrival burst.
			minute := (ordinal*37 + day*17) % (24 * 60)
			if ordinal%10 == 0 {
				minute = 600
			}
			result = append(result, FleetPullRequest{
				ID:         fmt.Sprintf("day-%d-dev-%d-pr-%d", day, developer, pr),
				Repository: active[(ordinal*13+developer+day)%len(active)],
				Developer:  developer, Number: day*developers*20 + ordinal + 1,
				ReadyAt: start.Add(time.Duration(minute) * time.Minute),
			})
			ordinal++
		}
	}
	return result
}
