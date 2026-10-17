package webhookgateway

import (
	"math"
	"testing"
	"time"
)

func TestDomainRetryDelaySaturatesAndBoundsExplicitJitter(t *testing.T) {
	for _, test := range []struct {
		name    string
		base    time.Duration
		attempt uint32
		jitter  time.Duration
		want    time.Duration
	}{
		{"disabled", 0, 1, time.Second, 0},
		{"negative-base", -1, 1, time.Second, 0},
		{"zero-attempt", time.Second, 0, 0, time.Second},
		{"first", time.Second, 1, 0, time.Second},
		{"second", time.Second, 2, 0, 2 * time.Second},
		{"third", time.Second, 3, 0, 4 * time.Second},
		{"explicit-jitter", time.Second, 3, time.Second, 5 * time.Second},
		{"excess-jitter", time.Second, 3, time.Hour, 5 * time.Second},
		{"negative-jitter", time.Second, 3, -time.Hour, 4 * time.Second},
		{"total-cap", 28 * time.Minute, 2, 10 * time.Minute, time.Hour},
		{"base-cap", time.Duration(math.MaxInt64), 1, time.Duration(math.MaxInt64), time.Hour},
		{"attempt-cap", time.Nanosecond, math.MaxUint32, time.Duration(math.MaxInt64), time.Hour},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := RetryDelay(test.base, test.attempt, test.jitter); got != test.want {
				t.Fatalf("got %s want %s", got, test.want)
			}
		})
	}
}

func TestDomainFinishUsesAttemptBackoffAndServerMinimum(t *testing.T) {
	_, _, job, _ := domainFixture(t)
	now := job.CreatedAt
	claimed, err := ClaimJob(now, job, job.Version, 1, "worker")
	if err != nil {
		t.Fatal(err)
	}
	claimed.Attempt = 1
	dispatching, err := StartDispatch(now, claimed, 1, "worker", AuthorizationDecision{Allowed: true})
	if err != nil {
		t.Fatal(err)
	}
	result := DispatchResult{Outcome: "retry", Reason: "rate-limited", RetryJitter: time.Second}
	retried, err := FinishDispatch(now, dispatching, 1, "worker", result)
	if err != nil || retried.State != Ready || !retried.NotBefore.Equal(now.Add(5*time.Second)) {
		t.Fatalf("second attempt must use 4s + 1s jitter: %+v %v", retried, err)
	}
	result.RetryAt = now.Add(10 * time.Second)
	retried, err = FinishDispatch(now, dispatching, 1, "worker", result)
	if err != nil || retried.State != Ready || !retried.NotBefore.Equal(result.RetryAt) {
		t.Fatalf("server retry minimum lost: %+v %v", retried, err)
	}
	result.RetryAt = job.ExpiresAt
	retried, err = FinishDispatch(now, dispatching, 1, "worker", result)
	if err != nil || retried.State != Expired {
		t.Fatalf("retry must respect expiry: %+v %v", retried, err)
	}
}
