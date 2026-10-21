package webhookgatewayhost

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	"github.com/githubnext/gh-cao/server/internal/operational"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

var errLabelAlreadyConsumed = errors.New("gateway label consumption already confirmed")

type LabelAPI interface {
	WebhookGatewayConsumeLabel(context.Context, gateway.Subscription, gateway.LabelRemoval, func() error, func(githubquota.ResponseQuota)) error
}

type LabelReceipts interface {
	OperationalState(context.Context, string) ([]byte, error)
	SetExpiringOperationalState(context.Context, string, []byte, time.Duration) error
}

type LabelConsumer struct {
	Authority    LiveAuthority
	GitHub       LabelAPI
	Deliveries   operational.DeliveryDeduplicator
	Receipts     LabelReceipts
	Quota        QuotaService
	ReceivingApp int64
}

func (c LabelConsumer) ConsumeLabels(ctx context.Context, jobs []gateway.Job) error {
	if c.GitHub == nil || c.Deliveries == nil || c.Receipts == nil || c.Quota == nil ||
		c.ReceivingApp <= 0 || gateway.ValidateBatchMembers(jobs) != nil {
		return gateway.ErrUnavailable
	}
	for _, job := range jobs {
		if err := c.consume(ctx, job); err != nil {
			return err
		}
	}
	return nil
}

func (c LabelConsumer) consume(ctx context.Context, job gateway.Job) error {
	if job.State != gateway.Dispatching || !time.Now().Before(job.LeaseUntil) || !time.Now().Before(job.ExpiresAt) {
		return gateway.ErrConflict
	}
	target, err := gateway.JobLabelRemoval(job)
	if err != nil {
		return err
	}
	key := "webhook-gateway:label:" + gateway.MetadataDigest([]byte(
		strconv.FormatInt(job.Subscription.Source.InstallationID, 10)+"\x00"+
			strconv.FormatInt(job.Subscription.Source.RepositoryID, 10)+"\x00"+job.Event.SourceID+"\x00"+
			job.DeliveryID+"\x00"+target.Event+"\x00"+target.Label))
	const retention = 8 * 24 * time.Hour
	receipt, err := c.Receipts.OperationalState(ctx, key)
	if err != nil {
		return gateway.ErrUnavailable
	}
	if bytes.Equal(receipt, []byte("consumed/v1")) {
		return nil
	}
	bucket := githubquota.BucketID{App: strconv.FormatInt(c.ReceivingApp, 10),
		Installation: job.Subscription.Source.InstallationID, Resource: githubquota.ResourceCore}
	if target.Event == "discussion" {
		bucket.Resource = "graphql"
	}
	var reservation *githubquota.Reservation
	var observationErr error
	var latest githubquota.ResponseQuota
	beforeWrite := func() error {
		if ctx.Err() != nil || !time.Now().Before(job.LeaseUntil) || !time.Now().Before(job.ExpiresAt) {
			return gateway.ErrConflict
		}
		evidence, err := c.Authority.Authorize(ctx, job)
		if err != nil {
			return gateway.ErrUnavailable
		}
		decision, err := gateway.ValidateAuthorization(time.Now(), job, evidence)
		if err != nil || !decision.Allowed {
			return gateway.ErrUnauthorized
		}
		if observationErr != nil {
			return gateway.ErrUnavailable
		}
		quota, err := c.Quota.Reserve(ctx, bucket, githubquota.ReservationRequest{
			EstimatedCost: 2, MinimumRemain: 100, TTL: time.Minute,
		})
		if err != nil {
			return gateway.ErrUnavailable
		}
		reservation = &quota
		fresh, err := c.Deliveries.RememberDelivery(ctx, key, retention)
		if err != nil {
			return gateway.ErrUnavailable
		}
		if !fresh {
			receipt, err := c.Receipts.OperationalState(ctx, key)
			if err == nil && bytes.Equal(receipt, []byte("consumed/v1")) {
				return errLabelAlreadyConsumed
			}
			// An earlier attempt may have reached GitHub. Never remove a label
			// reapplied after an ambiguous request or a process crash.
			return gateway.ErrUnavailable
		}
		return nil
	}
	observe := func(quota githubquota.ResponseQuota) {
		if quota.HasObservation && quota.Resource == bucket.Resource {
			latest = quota
		}
		if err := ObserveQuota(ctx, c.Quota, bucket.App, bucket.Installation, quota); err != nil {
			observationErr = errors.Join(observationErr, err)
		}
	}
	err = c.GitHub.WebhookGatewayConsumeLabel(ctx, job.Subscription, target, beforeWrite, observe)
	if reservation != nil {
		accountCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if errors.Is(err, errLabelAlreadyConsumed) {
			observationErr = errors.Join(observationErr, c.Quota.Release(accountCtx, *reservation))
		} else if latest.HasObservation {
			observed := latest.Observation
			observed.ObservedAt = time.Time{}
			observationErr = errors.Join(observationErr, c.Quota.Commit(accountCtx, *reservation, observed))
		}
	}
	if errors.Is(err, errLabelAlreadyConsumed) {
		return observationErr
	}
	if err != nil {
		return errors.Join(gateway.ErrUnavailable, observationErr)
	}
	accountCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := c.Receipts.SetExpiringOperationalState(accountCtx, key, []byte("consumed/v1"), retention); err != nil {
		return gateway.ErrUnavailable
	}
	return observationErr
}
