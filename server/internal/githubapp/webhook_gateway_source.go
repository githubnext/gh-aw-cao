package githubapp

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (d WebhookGatewayDispatcher) compilerSourcePreflight(ctx context.Context, subscription gateway.Subscription,
	payload json.RawMessage, destination GatewayRepository,
) error {
	if subscription.Compiler != nil && subscription.Source.ServerURL != "" &&
		(d.Receiving == nil || d.Receiving.WebhookGatewayServerURL() != subscription.Source.ServerURL) {
		return gateway.ErrUnauthorized
	}
	if subscription.Source.External != nil {
		if !time.Now().Before(subscription.Source.External.ExpiresAt) {
			return gateway.ErrUnauthorized
		}
		return gateway.ValidateBatchDispatchPayload(subscription, payload, gateway.DefaultLimits())
	}
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
	owner, _, _ := strings.Cut(source.FullName, "/")
	if !gateway.CompilerOrganizationMatches(*subscription.Compiler, owner, source.OwnerID, source.OwnerType) ||
		subscription.Compiler.Orgs != nil && source.OwnerID != subscription.Source.OrganizationID {
		return gateway.ErrUnauthorized
	}
	return gateway.CompilerBatchRepository(subscription, payload, source.FullName)
}
