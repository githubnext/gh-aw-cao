// Package webhookgatewayhost composes gateway infrastructure without giving the
// receiving HTTP process access to either App's private key.
package webhookgatewayhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

const proofLifetime = 30 * time.Second

type authorizationProof struct {
	Revision gateway.QueueRevision         `json:"revision"`
	Snapshot gateway.AuthorizationSnapshot `json:"snapshot"`
}

type AuthorityAPI interface {
	WebhookGatewayInstallation(context.Context, int64) (githubapp.GatewayInstallation, githubquota.ResponseQuota, error)
	WebhookGatewayRepository(context.Context, int64, int64, ...func(githubquota.ResponseQuota)) (githubapp.GatewayRepository, githubquota.ResponseQuota, error)
}

type ProjectAuthority interface {
	WebhookGatewayProjectsWithQuota(context.Context, int64, int64, []string, func(githubquota.ResponseQuota)) error
}

type WorkflowAuthority interface {
	WebhookGatewayWorkflowRevision(context.Context, int64, int64, string, func(githubquota.ResponseQuota)) (string, string, error)
}

type PolicyLoader interface {
	Load(context.Context) (gateway.PolicySnapshot, error)
}

type RevisionApplier interface {
	ApplyRevision(context.Context, gateway.QueueRevision) error
}

type LiveAuthority struct {
	Loader              PolicyLoader
	Queue               RevisionApplier
	Receiving, Dispatch AuthorityAPI
	State               operational.StateStore
	Quota               QuotaService
}

type ReceiveAuthority struct {
	Loader PolicyLoader
	Queue  RevisionApplier
	State  operational.StateStore
}

func (a LiveAuthority) AuthorizeBatch(ctx context.Context, jobs []gateway.Job) ([]gateway.AuthorizationSnapshot, error) {
	return gateway.AuthorizeCompatibleBatch(ctx, a, jobs)
}

func currentSubscription(policy gateway.PolicySnapshot, job gateway.Job) (gateway.Subscription, gateway.Revision, error) {
	if !policy.Revision.Enabled || policy.Revision != job.QueueRevision {
		return gateway.Subscription{}, gateway.Revision{}, gateway.ErrUnauthorized
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.ID != job.Subscription.ID {
			continue
		}
		if !policy.CompilerSourceAllowed(subscription) ||
			subscription.Source.External != nil && !gateway.ExternalSourceCurrent(policy, subscription, time.Now()) {
			return gateway.Subscription{}, gateway.Revision{}, gateway.ErrUnauthorized
		}
		revision := policy.Revisions[subscription.ID]
		expected, err := json.Marshal(subscription)
		if err != nil {
			return gateway.Subscription{}, gateway.Revision{}, err
		}
		actual, err := json.Marshal(job.Subscription)
		if err != nil || !bytes.Equal(expected, actual) || revision.Digest != job.SubscriptionDigest {
			return gateway.Subscription{}, gateway.Revision{}, gateway.ErrUnauthorized
		}
		return subscription, revision, nil
	}
	return gateway.Subscription{}, gateway.Revision{}, gateway.ErrUnauthorized
}

func proofKey(id string) string {
	return "webhook-gateway:authority:" + gateway.MetadataDigest([]byte(id))
}

func bind(snapshot gateway.AuthorizationSnapshot, job gateway.Job) gateway.AuthorizationSnapshot {
	snapshot.JobID = job.ID
	snapshot.Fence = job.Fence
	snapshot.Attempt = job.Attempt + 1
	return snapshot
}

// Authorize uses bounded-freshness evidence produced by the isolated dispatch
// role; the receiving process holds only the HMAC secret and database access.
func (a ReceiveAuthority) Authorize(ctx context.Context, job gateway.Job) (gateway.AuthorizationSnapshot, error) {
	policy, err := a.Loader.Load(ctx)
	if err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	if err := a.Queue.ApplyRevision(ctx, policy.Revision); err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	_, revision, err := currentSubscription(policy, job)
	if err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	data, err := a.State.OperationalState(ctx, proofKey(job.Subscription.ID))
	if err != nil {
		return gateway.AuthorizationSnapshot{}, gateway.ErrUnavailable
	}
	var stored authorizationProof
	now := time.Now().UTC()
	if json.Unmarshal(data, &stored) != nil || stored.Revision != policy.Revision {
		return gateway.AuthorizationSnapshot{}, gateway.ErrUnavailable
	}
	proof := stored.Snapshot
	if !proof.Complete || proof.CurrentRevision != revision ||
		proof.CheckedAt.After(now) || now.Sub(proof.CheckedAt) >= proofLifetime || !now.Before(proof.ExpiresAt) {
		return gateway.AuthorizationSnapshot{}, gateway.ErrUnavailable
	}
	proof.Grant = policy.Grants[job.Subscription.ID]
	return bind(proof, job), nil
}

// Authorize performs fresh GitHub installation and immutable-repository checks
// for every attempt. No cached evidence is used at egress.
func (a LiveAuthority) Authorize(ctx context.Context, job gateway.Job) (gateway.AuthorizationSnapshot, error) {
	policy, err := a.Loader.Load(ctx)
	if err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	if err := a.Queue.ApplyRevision(ctx, policy.Revision); err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	subscription, revision, err := currentSubscription(policy, job)
	if err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	now := time.Now().UTC()
	proof := gateway.AuthorizationSnapshot{
		CheckedAt: now, ExpiresAt: now.Add(proofLifetime),
		SourceInstallationID: subscription.Source.InstallationID,
		SourceRepositoryID:   subscription.Source.RepositoryID, SourceOrganizationID: subscription.Source.OrganizationID,
		ReceivingInstallationID:   subscription.Source.InstallationID,
		DestinationInstallationID: subscription.Destination.InstallationID,
		DestinationRepositoryID:   subscription.Destination.RepositoryID,
		CurrentRevision:           revision, Grant: policy.Grants[subscription.ID],
	}
	if subscription.Source.External != nil {
		proof.ExternalSourceID = subscription.Source.ID
	}
	proof, err = a.check(ctx, policy, subscription, proof)
	if err != nil {
		return gateway.AuthorizationSnapshot{}, err
	}
	if a.State != nil {
		data, marshalErr := json.Marshal(authorizationProof{Revision: policy.Revision, Snapshot: proof})
		if marshalErr != nil {
			return gateway.AuthorizationSnapshot{}, marshalErr
		}
		if err := a.State.SetOperationalState(ctx, proofKey(subscription.ID), data); err != nil {
			return gateway.AuthorizationSnapshot{}, gateway.ErrUnavailable
		}
	}
	return bind(proof, job), nil
}

func permissionsAllow(actual, required map[string]string) bool {
	for permission, level := range required {
		got := actual[permission]
		if got != "write" && (got != "read" || level != "read") {
			return false
		}
	}
	return true
}

func authorityFailure(proof gateway.AuthorizationSnapshot, err error) (gateway.AuthorizationSnapshot, error) {
	var response *githubapp.GatewayAPIError
	if errors.Is(err, gateway.ErrUnauthorized) ||
		(errors.As(err, &response) && (response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusUnprocessableEntity)) {
		proof.Complete = true
		proof.SourceAccessible, proof.DestinationAccessible = false, false
		return proof, nil
	}
	return proof, gateway.ErrUnavailable
}

func (a LiveAuthority) check(ctx context.Context, policy gateway.PolicySnapshot, subscription gateway.Subscription, proof gateway.AuthorizationSnapshot) (gateway.AuthorizationSnapshot, error) {
	if subscription.Source.External != nil {
		return a.checkExternal(ctx, policy, subscription, proof)
	}
	if subscription.Compiler != nil && subscription.Source.ServerURL != "" {
		origin, ok := a.Receiving.(interface{ WebhookGatewayServerURL() string })
		if !ok || origin.WebhookGatewayServerURL() != subscription.Source.ServerURL {
			return proof, gateway.ErrUnauthorized
		}
	}
	receiver, _, err := a.Receiving.WebhookGatewayInstallation(ctx, subscription.Source.InstallationID)
	if err != nil {
		return authorityFailure(proof, err)
	}
	dispatcher, _, err := a.Dispatch.WebhookGatewayInstallation(ctx, subscription.Destination.InstallationID)
	if err != nil {
		return authorityFailure(proof, err)
	}
	if receiver.AppID != policy.Policy.ReceivingAppID || dispatcher.AppID != policy.Policy.DispatchAppID {
		return proof, gateway.ErrUnauthorized
	}
	proof.Complete = true
	proof.SourceAccessible = !receiver.Suspended
	proof.DestinationAccessible = !dispatcher.Suspended
	proof.SourcePermissionsOK = permissionsAllow(receiver.Permissions, subscription.Source.RequiredPermissions) &&
		receiver.Permissions["actions"] != "write" && receiver.Permissions["contents"] != "write"
	if len(subscription.Source.ProjectIDs) > 0 {
		for _, project := range subscription.Source.ProjectIDs {
			if !policy.ProjectAssigned(project, subscription.Source.OrganizationID, subscription.Destination.RepositoryID) {
				proof.Complete, proof.SourceAccessible = true, false
				return proof, nil
			}
		}
		projects, supported := a.Receiving.(ProjectAuthority)
		if !supported || subscription.Source.OrganizationID <= 0 {
			return proof, gateway.ErrUnavailable
		}
		var quotaErr error
		projectErr := projects.WebhookGatewayProjectsWithQuota(ctx, subscription.Source.InstallationID, subscription.Source.OrganizationID, subscription.Source.ProjectIDs,
			func(response githubquota.ResponseQuota) {
				if a.Quota != nil {
					quotaErr = errors.Join(quotaErr, ObserveQuota(ctx, a.Quota, strconv.FormatInt(policy.Policy.ReceivingAppID, 10),
						subscription.Source.InstallationID, response))
				}
			})
		if quotaErr != nil {
			return proof, gateway.ErrUnavailable
		}
		if err := projectErr; err != nil {
			if !errors.Is(err, gateway.ErrUnauthorized) {
				return proof, gateway.ErrUnavailable
			}
			proof.SourceAccessible = false
		}
	}
	required := "actions"
	if subscription.Destination.Kind == "repository_dispatch" {
		required = "contents"
	}
	proof.DispatchPermissionsOK = dispatcher.Permissions[required] == "write"
	if subscription.Source.OrganizationID > 0 {
		proof.SourceAccessible = proof.SourceAccessible && receiver.AccountType == "Organization" &&
			receiver.AccountID == subscription.Source.OrganizationID
		if subscription.Source.RepositoryID == 0 {
			proof.SourceAccessible = proof.SourceAccessible && policy.OwnerAllowed(receiver.AccountLogin)
		}
		// Organization webhook records are restricted data even when the
		// organization's profile happens to be public.
		proof.SourceVisibility = "private"
	}
	if subscription.Source.RepositoryID > 0 {
		source, _, sourceErr := a.Receiving.WebhookGatewayRepository(ctx, subscription.Source.InstallationID, subscription.Source.RepositoryID)
		if sourceErr != nil {
			return authorityFailure(proof, sourceErr)
		}
		proof.SourceAccessible = proof.SourceAccessible && source.ID == subscription.Source.RepositoryID &&
			source.Private && source.Visibility == "private" &&
			!source.Disabled && !source.Archived && policy.RepositoryAllowed(source.FullName) &&
			source.OwnerID == receiver.AccountID
		if subscription.Source.OrganizationID > 0 && source.OwnerID != subscription.Source.OrganizationID {
			proof.SourceAccessible = false
		}
		proof.SourceVisibility = source.Visibility
		if subscription.Compiler != nil && !gateway.CompilerRepositoryMatches(*subscription.Compiler, source.FullName) {
			proof.SourceAccessible = false
		}
		if subscription.Compiler != nil && subscription.Compiler.Orgs != nil {
			owner, _, _ := strings.Cut(source.FullName, "/")
			proof.SourceAccessible = proof.SourceAccessible && source.OwnerType == "Organization" &&
				strings.EqualFold(owner, receiver.AccountLogin) &&
				gateway.CompilerOrganizationMatches(*subscription.Compiler, receiver.AccountLogin, receiver.AccountID, receiver.AccountType)
		}
	}
	return a.checkDestination(ctx, policy, subscription, proof, dispatcher.AccountID)
}

func (a LiveAuthority) checkDestination(ctx context.Context, policy gateway.PolicySnapshot, subscription gateway.Subscription, proof gateway.AuthorizationSnapshot, ownerID int64) (gateway.AuthorizationSnapshot, error) {
	destination, _, err := a.Dispatch.WebhookGatewayRepository(ctx, subscription.Destination.InstallationID, subscription.Destination.RepositoryID)
	if err != nil {
		return authorityFailure(proof, err)
	}
	proof.DestinationAccessible = proof.DestinationAccessible && destination.ID == subscription.Destination.RepositoryID &&
		destination.Private && destination.Visibility == "private" &&
		!destination.Disabled && !destination.Archived && policy.RepositoryAllowed(destination.FullName) &&
		destination.OwnerID == ownerID
	proof.DestinationVisibility = destination.Visibility
	if subscription.Compiler != nil && proof.SourceAccessible && proof.DestinationAccessible {
		workflows, ok := a.Dispatch.(WorkflowAuthority)
		if !ok {
			return proof, gateway.ErrUnavailable
		}
		var quotaErr error
		head, digest, err := workflows.WebhookGatewayWorkflowRevision(ctx, subscription.Destination.InstallationID,
			subscription.Destination.RepositoryID, subscription.Compiler.Dispatch.Workflow, func(response githubquota.ResponseQuota) {
				if a.Quota != nil {
					quotaErr = errors.Join(quotaErr, ObserveQuota(ctx, a.Quota,
						strconv.FormatInt(policy.Policy.DispatchAppID, 10), subscription.Destination.InstallationID, response))
				}
			})
		if quotaErr != nil {
			return proof, gateway.ErrUnavailable
		}
		if err != nil {
			return authorityFailure(proof, err)
		}
		if head != proof.CurrentRevision.CommitSHA || digest != proof.CurrentRevision.Digest {
			proof.SourceAccessible = false
		}
	}
	if subscription.Compiler != nil && proof.Grant.ExpiresAt.Before(proof.ExpiresAt) {
		proof.ExpiresAt = proof.Grant.ExpiresAt
	}
	return proof, nil
}

// Refresh primes receiver evidence even while the queue is empty. Inventory is
// bounded by the reviewed policy, and failures never retain proof indefinitely.
func (a LiveAuthority) Refresh(ctx context.Context) error {
	return (&AuthorityRefresher{Authority: a}).Refresh(ctx)
}

// AuthorityRefresher belongs to one primer loop. Its cursor advances even when
// a slow subscription exhausts the round deadline, so later routes get a turn.
type AuthorityRefresher struct {
	Authority LiveAuthority
	next      int
}

func (r *AuthorityRefresher) Refresh(ctx context.Context) error {
	a := r.Authority
	policy, err := a.Loader.Load(ctx)
	if err != nil {
		return err
	}
	if err := a.Queue.ApplyRevision(ctx, policy.Revision); err != nil {
		return err
	}
	if !policy.Revision.Enabled {
		return nil
	}
	var failures []error
	if len(policy.Subscriptions) == 0 {
		r.next = 0
		return nil
	}
	start := r.next % len(policy.Subscriptions)
	for offset := range len(policy.Subscriptions) {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		index := (start + offset) % len(policy.Subscriptions)
		subscription := policy.Subscriptions[index]
		r.next = (index + 1) % len(policy.Subscriptions)
		job := gateway.Job{
			Subscription: subscription, SubscriptionDigest: policy.Revisions[subscription.ID].Digest,
			QueueRevision: policy.Revision,
		}
		if _, err := a.Authorize(ctx, job); err != nil {
			failures = append(failures, errors.New("gateway authority refresh incomplete"))
		}
	}
	return errors.Join(append(failures, ctx.Err())...)
}
