package webhookgatewayhost

import (
	"context"
	"time"

	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (a LiveAuthority) checkExternal(ctx context.Context, policy gateway.PolicySnapshot, subscription gateway.Subscription,
	proof gateway.AuthorizationSnapshot,
) (gateway.AuthorizationSnapshot, error) {
	if !gateway.ExternalSourceCurrent(policy, subscription, time.Now()) {
		proof.Complete = true
		return proof, nil
	}
	dispatcher, _, err := a.Dispatch.WebhookGatewayInstallation(ctx, subscription.Destination.InstallationID)
	if err != nil {
		return authorityFailure(proof, err)
	}
	if dispatcher.AppID != policy.Policy.DispatchAppID {
		return proof, gateway.ErrUnauthorized
	}
	proof.Complete = true
	proof.SourceAccessible, proof.SourcePermissionsOK = true, true
	// Treat external resource references as restricted without claiming a live
	// provider visibility/access probe; workflows must use authenticated readers.
	proof.SourceVisibility = "private"
	proof.DestinationAccessible = !dispatcher.Suspended
	proof.DispatchPermissionsOK = dispatcher.Permissions["contents"] == "write"
	if subscription.Source.External.ExpiresAt.Before(proof.ExpiresAt) {
		proof.ExpiresAt = subscription.Source.External.ExpiresAt
	}
	return a.checkDestination(ctx, policy, subscription, proof, dispatcher.AccountID)
}
