package simulator

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestManualClockAndQuotaWindows(t *testing.T) {
	c := NewManualClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	calls := 0
	api := &QuotaAPI{Clock: c, Limits: QuotaLimits{RequestsPerHour: 3, PointsPerMinute: 6},
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls++
			w.WriteHeader(http.StatusNoContent)
		})}
	request := func(method, token string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequestWithContext(t.Context(), method, "/repos/simulator/repo/dispatches", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("quota response=%d want=%d", w.Code, want)
		}
		return w
	}
	request(http.MethodPost, "one", 204) // five points
	request(http.MethodGet, "one", 204)
	w := request(http.MethodGet, "one", 429)
	if w.Header().Get("Retry-After") != "60" || calls != 2 {
		t.Fatal("secondary rejection reached upstream or lost retry timing")
	}
	request(http.MethodPost, "two", 204)
	c.Advance(time.Minute)
	request(http.MethodGet, "one", 204)
	w = request(http.MethodGet, "one", 403)
	if w.Header().Get("X-RateLimit-Remaining") != "0" ||
		w.Header().Get("X-RateLimit-Reset") != "1767229200" || calls != 4 {
		t.Fatal("primary rejection reached upstream or lost reset timing")
	}
	c.Advance(59 * time.Minute)
	request(http.MethodPost, "one", 204)
	if api.Stats() != (QuotaStats{Requests: 7, Primary: 1, Secondary: 1}) {
		t.Fatalf("incorrect quota accounting: %+v", api.Stats())
	}
}

func TestFleetWorkloadPopulationAndMedian(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	repos := []FleetRepository{{ID: 1001}, {ID: 1002}}
	prs := FleetDay(start, 0, 5000, repos)
	if len(prs) != 50000 || !reflect.DeepEqual(prs, FleetDay(start, 0, 5000, repos)) {
		t.Fatal("fleet workload count or determinism changed")
	}
	counts := make([]int, 5000)
	ids := make(map[string]bool, len(prs))
	burst := 0
	for _, pr := range prs {
		counts[pr.Developer]++
		if ids[pr.ID] || pr.ReadyAt.Before(start) || !pr.ReadyAt.Before(start.Add(24*time.Hour)) {
			t.Fatal("duplicate PR identity or out-of-day arrival")
		}
		ids[pr.ID] = true
		if pr.ReadyAt.Equal(start.Add(600 * time.Minute)) {
			burst++
		}
	}
	slices.Sort(counts)
	if counts[2500] != 10 || counts[0] != 2 || counts[4999] != 18 || burst < 5000 {
		t.Fatal("population, p50 or burst changed")
	}
}

func TestFleetRepositoryLifecycle(t *testing.T) {
	c := NewManualClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	f := &FleetAPI{Clock: c}
	first, second := f.Create(), f.Create()
	f.Retire(first.ID, false)
	f.Retire(second.ID, true)
	f.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/repositories/1001", nil))
	w := httptest.NewRecorder()
	f.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/repositories/1002", nil))
	if !f.Repositories()[0].Archived || !f.Repositories()[1].Deleted || w.Code != 404 || f.Create().ID != 1003 {
		t.Fatal("repository churn reused identities or failed to remove access")
	}
}
