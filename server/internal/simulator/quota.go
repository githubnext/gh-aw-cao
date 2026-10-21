package simulator

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-cao/server/internal/clock"
)

type QuotaLimits struct {
	RequestsPerHour int
	PointsPerMinute int
}

type quotaBucket struct {
	hour, minute     int64
	requests, points int
}

type QuotaStats struct {
	Requests  int `json:"requests"`
	Primary   int `json:"primaryThrottles"`
	Secondary int `json:"secondaryThrottles"`
}

// QuotaAPI enforces independent installation primary budgets and secondary
// REST point budgets (GET=1, writes=5). Rejections never reach the wrapped API.
// It models these two limits, not every undocumented GitHub abuse heuristic.
type QuotaAPI struct {
	Handler http.Handler
	Clock   clock.Provider
	Limits  QuotaLimits
	mu      sync.Mutex
	buckets map[string]*quotaBucket
	stats   QuotaStats
}

func (q *QuotaAPI) Stats() QuotaStats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.stats
}

func (q *QuotaAPI) bucket(key string, now time.Time) *quotaBucket {
	if q.buckets == nil {
		q.buckets = make(map[string]*quotaBucket)
	}
	b := q.buckets[key]
	if b == nil {
		b = &quotaBucket{}
		q.buckets[key] = b
	}
	hour, minute := now.Unix()/3600, now.Unix()/60
	if b.hour != hour {
		b.hour, b.requests = hour, 0
	}
	if b.minute != minute {
		b.minute, b.points = minute, 0
	}
	return b
}

// ExhaustPrimary represents other consumers of the same installation budget.
func (q *QuotaAPI) ExhaustPrimary(installation int64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	b := q.bucket("simulator-installation-"+strconv.FormatInt(installation, 10), clock.Now(q.Clock))
	b.requests = q.Limits.RequestsPerHour
}

func (q *QuotaAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Token minting is an App endpoint, outside the installation REST budget.
	if strings.Contains(r.URL.Path, "/app/installations/") {
		q.Handler.ServeHTTP(w, r)
		return
	}
	key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	key = strings.TrimPrefix(key, "token ")
	now := clock.Now(q.Clock)
	q.mu.Lock()
	b := q.bucket(key, now)
	q.stats.Requests++
	reset := time.Unix((now.Unix()/3600+1)*3600, 0)
	points := 1
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		points = 5
	}
	status, message := 0, ""
	switch {
	case b.requests >= q.Limits.RequestsPerHour:
		q.stats.Primary++
		status, message = http.StatusForbidden, `{"message":"API rate limit exceeded"}`
	case b.points+points > q.Limits.PointsPerMinute:
		q.stats.Secondary++
		status, message = http.StatusTooManyRequests, `{"message":"You have exceeded a secondary rate limit"}`
		w.Header().Set("Retry-After", strconv.FormatInt(60-now.Unix()%60, 10))
	default:
		b.requests++
		b.points += points
	}
	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(q.Limits.RequestsPerHour))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(max(0, q.Limits.RequestsPerHour-b.requests)))
	w.Header().Set("X-RateLimit-Used", strconv.Itoa(b.requests))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
	w.Header().Set("X-RateLimit-Resource", "core")
	q.mu.Unlock()
	if status != 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(message))
		return
	}
	q.Handler.ServeHTTP(w, r)
}
