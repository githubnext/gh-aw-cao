package localops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

type quotaSnapshot struct {
	identity     string
	observations map[string]githubquota.Observation
}
type quotaReservation struct {
	buckets  []githubquota.Reservation
	finished bool
}
type nativeQuota struct {
	mu           sync.Mutex
	store        *memory.Store
	service      *githubquota.Service
	options      Options
	reservations map[int64]*quotaReservation
	parkedUntil  time.Time
	now          func() time.Time
	read         func(context.Context, []string) (quotaSnapshot, error)
}

func githubHost() string {
	if host := os.Getenv("GH_HOST"); host != "" {
		return host
	}
	return "github.com"
}
func newNativeQuota(options Options) (*nativeQuota, error) {
	store, err := memory.New(memory.Config{})
	if err != nil {
		return nil, err
	}
	service, err := githubquota.New(store, githubquota.Options{})
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	q := &nativeQuota{store: store, service: service, options: options, reservations: map[int64]*quotaReservation{}, now: time.Now}
	q.read = func(ctx context.Context, resources []string) (quotaSnapshot, error) {
		host := githubHost()
		user, err := readCommand(ctx, options, 16<<10, "api", "--hostname", host, "user", "--jq", ".id")
		if err != nil {
			return quotaSnapshot{}, errors.New("github credential identity is unavailable")
		}
		var userID int64
		if json.Unmarshal(user, &userID) != nil || userID <= 0 {
			return quotaSnapshot{}, errors.New("github credential identity is invalid")
		}
		raw, err := readCommand(ctx, options, 128<<10, "api", "--hostname", host, "rate_limit")
		if err != nil {
			return quotaSnapshot{}, errors.New("github quota observation is unavailable")
		}
		var response struct {
			Resources map[string]struct {
				Limit, Remaining *int
				Reset            int64
			}
		}
		if json.Unmarshal(raw, &response) != nil {
			return quotaSnapshot{}, errors.New("github quota observation is invalid")
		}
		sum := sha256.Sum256(fmt.Appendf(nil, "%s:%d", strings.ToLower(host), userID))
		snapshot := quotaSnapshot{identity: "gh-" + hex.EncodeToString(sum[:24]), observations: map[string]githubquota.Observation{}}
		for _, resource := range resources {
			meter, present := response.Resources[resource]
			if !present || meter.Limit == nil || meter.Remaining == nil || *meter.Limit <= 0 || *meter.Remaining < 0 || *meter.Remaining > *meter.Limit || meter.Reset <= 0 {
				return quotaSnapshot{}, errors.New("github quota observation is incomplete")
			}
			snapshot.observations[resource] = githubquota.Observation{Limit: *meter.Limit, Remaining: *meter.Remaining, ResetAt: time.Unix(meter.Reset, 0)}
		}
		return snapshot, nil
	}
	return q, nil
}
func quotaResources(command string) []string {
	tokens, err := ParseCommand(command)
	if err == nil && len(tokens) > 2 && tokens[0] == "gh" && tokens[1] == "workflow" && tokens[2] == "run" {
		return []string{"core"}
	}
	return []string{"core", "graphql"}
}
func quotaBucket(identity, resource string) githubquota.BucketID {
	return githubquota.BucketID{App: identity, Installation: 1, Resource: resource}
}
func (q *nativeQuota) refresh(ctx context.Context, resources []string) (quotaSnapshot, error) {
	current, err := q.read(ctx, resources)
	if err != nil {
		return quotaSnapshot{}, err
	}
	for _, resource := range resources {
		observation, present := current.observations[resource]
		if !present || !observation.ResetAt.After(q.now()) || observation.Limit <= 0 {
			return quotaSnapshot{}, errors.New("github quota observation is unusable")
		}
		if err = q.service.Observe(ctx, quotaBucket(current.identity, resource), observation); err != nil {
			return quotaSnapshot{}, err
		}
	}
	for id, held := range q.reservations {
		done := true
		for _, reservation := range held.buckets {
			if held.finished && reservation.Bucket.App == current.identity {
				observation, present := current.observations[reservation.Bucket.Resource]
				if !present {
					done = false
					continue
				}
				if err = q.service.Commit(ctx, reservation, observation); err != nil {
					return quotaSnapshot{}, err
				}
			} else if reservation.ExpiresAt.After(q.now()) {
				done = false
			}
		}
		if done {
			delete(q.reservations, id)
		}
	}
	return current, nil
}
func (q *nativeQuota) admit(ctx context.Context, id int64, invocation Invocation, running int) (int, string) {
	if localQuotaBypass(invocation.Command) {
		return q.options.MaxConcurrency, ""
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if running >= q.options.MaxConcurrency {
		return 0, "CLI command concurrency is exhausted."
	}
	if q.parkedUntil.After(q.now()) {
		return 0, "GitHub quota is parked after a secondary rate limit."
	}
	resources := quotaResources(invocation.Command)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	current, err := q.refresh(ctx, resources)
	if err != nil {
		return 0, "GitHub quota is unknown."
	}
	active := 0
	for _, held := range q.reservations {
		if !held.finished {
			active++
		}
	}
	capacity := q.options.MaxConcurrency
	for _, resource := range resources {
		state, err := q.service.State(ctx, quotaBucket(current.identity, resource))
		if err != nil || state.Status == githubquota.StatusUnknown {
			return 0, "GitHub quota is unknown."
		}
		if state.Status == githubquota.StatusParked {
			return 0, "GitHub quota is parked after a secondary rate limit."
		}
		available := max(0, (state.Available-100)/50)
		if available == 0 {
			return 0, "GitHub quota is exhausted."
		}
		capacity = min(capacity, active+available)
	}
	if max(active, running) >= capacity {
		return capacity, "CLI command concurrency is exhausted."
	}
	held := &quotaReservation{}
	for _, resource := range resources {
		reservation, err := q.service.Reserve(ctx, quotaBucket(current.identity, resource), githubquota.ReservationRequest{EstimatedCost: 50, MinimumRemain: 100, TTL: 20 * time.Minute})
		if err != nil {
			for _, previous := range held.buckets {
				_ = q.service.Release(ctx, previous)
			}
			return 0, "GitHub quota is unknown."
		}
		held.buckets = append(held.buckets, reservation)
	}
	q.reservations[id] = held
	return capacity, ""
}
func (q *nativeQuota) release(ctx context.Context, id int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	held := q.reservations[id]
	if held == nil {
		return nil
	}
	for _, reservation := range held.buckets {
		if err := q.service.Release(ctx, reservation); err != nil {
			return err
		}
	}
	delete(q.reservations, id)
	return nil
}
func (q *nativeQuota) complete(ctx context.Context, id int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	held := q.reservations[id]
	if held == nil || held.finished {
		return nil
	}
	held.finished = true
	resources := make([]string, 0, len(held.buckets))
	for _, reservation := range held.buckets {
		resources = append(resources, reservation.Bucket.Resource)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, err := q.refresh(ctx, resources)
	return err
}
func (q *nativeQuota) park(ctx context.Context, seconds int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.parkedUntil = maxTime(q.parkedUntil, q.now().Add(time.Duration(min(86400, max(60, seconds)))*time.Second))
	for _, held := range q.reservations {
		for _, reservation := range held.buckets {
			_ = q.service.Park(ctx, reservation.Bucket, q.parkedUntil, githubquota.ParkReasonSecondaryRateLimit)
		}
	}
}

var retryAfterPattern = regexp.MustCompile(`(?i)retry-after\s*:\s*([0-9]+)`)

func detectRateLimit(text string) (bool, int) {
	lower := strings.ToLower(text)
	limited := strings.Contains(lower, "secondary rate limit") || strings.Contains(lower, "abuse detection") || strings.Contains(lower, "http 429") || strings.Contains(lower, "too many requests") || regexp.MustCompile(`(?i)retry-after\s*:`).MatchString(text)
	seconds := 0
	if match := retryAfterPattern.FindStringSubmatch(text); limited && len(match) > 1 {
		seconds, _ = strconv.Atoi(match[1])
		seconds = min(86400, max(0, seconds))
	}
	return limited, seconds
}

type rateLimitObserver struct {
	tails      map[string]string
	limited    bool
	retryAfter int
}

func (o *rateLimitObserver) write(stream, data string) {
	if o.tails == nil {
		o.tails = map[string]string{}
	}
	text := o.tails[stream] + data
	limited, retry := detectRateLimit(text)
	o.limited = o.limited || limited
	o.retryAfter = max(o.retryAfter, retry)
	if len(text) > 128 {
		text = text[len(text)-128:]
	}
	o.tails[stream] = text
}
