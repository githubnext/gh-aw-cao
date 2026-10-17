package webhookgatewayhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type quotaFake struct {
	released, committed, parked int
	err                         error
}

func (q *quotaFake) Observe(context.Context, githubquota.BucketID, githubquota.Observation) error {
	return q.err
}
func (q *quotaFake) Reserve(_ context.Context, bucket githubquota.BucketID, _ githubquota.ReservationRequest) (githubquota.Reservation, error) {
	return githubquota.Reservation{ID: "reservation", Bucket: bucket, Amount: 2}, q.err
}
func (q *quotaFake) Commit(context.Context, githubquota.Reservation, githubquota.Observation) error {
	q.committed++
	return q.err
}
func (q *quotaFake) Release(context.Context, githubquota.Reservation) error {
	q.released++
	return q.err
}
func (q *quotaFake) Park(context.Context, githubquota.BucketID, time.Time, string) error {
	q.parked++
	return q.err
}

type quotaReader struct{ observation bool }

func (q quotaReader) QuotaRateLimit(context.Context, int64) (githubquota.ResponseQuota, error) {
	return githubquota.ResponseQuota{HasResponse: true, HasObservation: q.observation,
		Observation: githubquota.Observation{Limit: 5000, Remaining: 4999, ResetAt: time.Now().Add(time.Hour)}}, nil
}

type quotaDispatch struct{ unknown bool }

func (q quotaDispatch) DispatchWithQuota(_ context.Context, s gateway.Subscription, _ json.RawMessage) (gateway.DispatchResponse, githubquota.ResponseQuota) {
	if q.unknown {
		return gateway.DispatchResponse{Kind: s.Destination.Kind, TransportOutcome: "unknown"}, githubquota.ResponseQuota{}
	}
	return gateway.DispatchResponse{Kind: s.Destination.Kind, StatusCode: 204, TransportOutcome: "response"},
		githubquota.ResponseQuota{HasResponse: true, HasObservation: true,
			Observation: githubquota.Observation{Limit: 5000, Remaining: 4997, ResetAt: time.Now().Add(time.Hour)}}
}

func TestQuotaGateReservesBeforeDispatchAndPreservesAmbiguity(t *testing.T) {
	for _, scenario := range []string{"not-sent", "accepted", "unknown", "unknown-budget"} {
		t.Run(scenario, func(t *testing.T) {
			quota := &quotaFake{}
			job := gateway.Job{Subscription: gateway.Subscription{ID: "subscription",
				Destination: gateway.Destination{Kind: "repository_dispatch", InstallationID: 20}}}
			gate := &QuotaGate{Service: quota, Reader: quotaReader{scenario != "unknown-budget"},
				Dispatcher: quotaDispatch{scenario == "unknown"}, AppID: 2}
			release, err := gate.Acquire(t.Context(), job)
			if scenario == "unknown-budget" {
				if err == nil {
					t.Fatal("unknown quota admitted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario != "not-sent" {
				gate.Dispatch(t.Context(), job.Subscription, json.RawMessage(`{}`))
			}
			release()
			if scenario == "not-sent" && quota.released != 1 {
				t.Fatal("unused reservation was not returned")
			}
			if scenario == "accepted" && (quota.committed != 1 || quota.released != 0) {
				t.Fatal("accepted reservation not committed exactly once")
			}
			if scenario == "unknown" && (quota.parked != 1 || quota.released != 0) {
				t.Fatal("uncertain request quota was refunded")
			}
		})
	}
}

type apiLimiter struct{ allowed bool }

func (l apiLimiter) TakeRateLimitToken(context.Context, string, int, time.Duration) (operational.RateLimitResult, error) {
	return operational.RateLimitResult{Allowed: l.allowed}, nil
}
func (l apiLimiter) TakeRateLimitTokens(context.Context, string, int, time.Duration, int) (operational.RateLimitResult, error) {
	return operational.RateLimitResult{Allowed: l.allowed}, nil
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAPIBudgetStopsHTTPBeforeSending(t *testing.T) {
	calls := 0
	transport := BudgetTransport{Limiter: apiLimiter{false}, Next: transportFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 204, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "https://api.github.com/rate_limit", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.RoundTrip(request)
	if response != nil {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
	}
	if !errors.Is(err, ErrAPIBudget) || calls != 0 {
		t.Fatal("exhausted distributed budget made an HTTP call")
	}
}
