package githubapp

import (
	"context"
	"encoding/json"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func (d WebhookGatewayDispatcher) compilerSourcePreflight(ctx context.Context, subscription gateway.Subscription,
	payload json.RawMessage, destination GatewayRepository,
) error {
	source := destination
	if subscription.Source.RepositoryID != destination.ID {
		if d.Receiving == nil {
			return gateway.ErrUnavailable
		}
		var observationErr error
		var err error
		source, _, err = d.Receiving.WebhookGatewayRepository(ctx, subscription.Source.InstallationID,
			subscription.Source.RepositoryID, func(quota githubquota.ResponseQuota) {
				if d.ObserveReceivingQuota != nil && observationErr == nil {
					observationErr = d.ObserveReceivingQuota(ctx, subscription.Source.InstallationID, quota)
				}
			})
		if err != nil || observationErr != nil {
			return gateway.ErrUnavailable
		}
	}
	if source.ID != subscription.Source.RepositoryID || !source.Private || source.Visibility != "private" ||
		source.Disabled || source.Archived {
		return gateway.ErrUnauthorized
	}
	return gateway.CompilerBatchRepository(subscription, payload, source.FullName)
}
