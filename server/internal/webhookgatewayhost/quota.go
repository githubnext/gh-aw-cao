package webhookgatewayhost

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type QuotaService interface {
	Observe(context.Context, githubquota.BucketID, githubquota.Observation) error
	Reserve(context.Context, githubquota.BucketID, githubquota.ReservationRequest) (githubquota.Reservation, error)
	Commit(context.Context, githubquota.Reservation, githubquota.Observation) error
	Release(context.Context, githubquota.Reservation) error
	Park(context.Context, githubquota.BucketID, time.Time, string) error
}

type QuotaReader interface {
	QuotaRateLimit(context.Context, int64) (githubquota.ResponseQuota, error)
}

type QuotaDispatcher interface {
	DispatchWithQuota(context.Context, gateway.Subscription, json.RawMessage) (gateway.DispatchResponse, githubquota.ResponseQuota)
}

// QuotaGate belongs to exactly one Worker. Reservations and parking themselves
// are durable and shared across replicas through the existing quota service.
type QuotaGate struct {
	Service    QuotaService
	Reader     QuotaReader
	Dispatcher QuotaDispatcher
	AppID      int64

	reservation    *githubquota.Reservation
	subscriptionID string
	sent           bool
}

func (g *QuotaGate) Acquire(ctx context.Context, job gateway.Job) (func(), error) {
	if g.Service == nil || g.Reader == nil || g.Dispatcher == nil || g.AppID <= 0 || g.reservation != nil {
		return nil, gateway.ErrUnavailable
	}
	installation := job.Subscription.Destination.InstallationID
	bucket := githubquota.BucketID{App: strconv.FormatInt(g.AppID, 10), Installation: installation, Resource: githubquota.ResourceCore}
	quota, err := g.Reader.QuotaRateLimit(ctx, installation)
	if observeErr := ObserveQuota(ctx, g.Service, bucket.App, installation, quota); observeErr != nil {
		return nil, gateway.ErrUnavailable
	}
	if err != nil || !quota.HasObservation {
		return nil, gateway.ErrUnavailable
	}
	reservation, err := g.Service.Reserve(ctx, bucket, githubquota.ReservationRequest{
		EstimatedCost: 2, MinimumRemain: 100, TTL: 2 * time.Minute,
	})
	if err != nil {
		return nil, err
	}
	g.reservation, g.subscriptionID, g.sent = &reservation, job.Subscription.ID, false
	return func() {
		if g.reservation == nil {
			return
		}
		// Unknown requests retain their reservation until its bounded expiry.
		// Only a request proven not sent may immediately return its promise.
		if !g.sent {
			releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = g.Service.Release(releaseCtx, *g.reservation)
		}
		g.reservation = nil
	}, nil
}

func (g *QuotaGate) Dispatch(ctx context.Context, subscription gateway.Subscription, payload json.RawMessage) gateway.DispatchResponse {
	if g.reservation == nil || subscription.ID != g.subscriptionID ||
		subscription.Destination.InstallationID != g.reservation.Bucket.Installation {
		return gateway.DispatchResponse{Kind: subscription.Destination.Kind, TransportOutcome: "not-sent"}
	}
	g.sent = true
	response, quota := g.Dispatcher.DispatchWithQuota(ctx, subscription, payload)
	// Persist quota even when the dispatch deadline has just elapsed. Failure
	// here must never turn accepted work into a replay.
	accountCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	switch {
	case quota.HasObservation:
		observation := quota.Observation
		observation.ObservedAt = time.Time{}
		if g.Service.Commit(accountCtx, *g.reservation, observation) == nil {
			g.reservation = nil
		}
	case response.TransportOutcome == "not-sent":
		g.sent = false
	default:
		_ = g.Service.Park(accountCtx, g.reservation.Bucket, time.Now().Add(time.Hour), "unknown-dispatch-quota")
	}
	_ = ObserveQuota(accountCtx, g.Service, strconv.FormatInt(g.AppID, 10), subscription.Destination.InstallationID, quota)
	return response
}

func ObserveQuota(ctx context.Context, service QuotaService, app string, installation int64, quota githubquota.ResponseQuota) error {
	bucket := githubquota.BucketID{App: app, Installation: installation, Resource: githubquota.ResourceCore}
	var failures []error
	if quota.HasObservation {
		observation := quota.Observation
		observation.ObservedAt = time.Time{}
		if err := service.Observe(ctx, bucket, observation); err != nil {
			failures = append(failures, err)
		}
	}
	if !quota.ParkUntil.IsZero() {
		if err := service.Park(ctx, bucket, quota.ParkUntil, quota.ParkReason); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

var _ QuotaDispatcher = githubapp.WebhookGatewayDispatcher{}
