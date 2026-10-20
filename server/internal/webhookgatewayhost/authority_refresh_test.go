package webhookgatewayhost

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/githubapp"
	"github.com/githubnext/gh-cao/server/internal/githubquota"
)

type interruptedAuthorityAPI struct {
	authorityAPI
	calls  []int64
	cancel context.CancelFunc
}

func (a *interruptedAuthorityAPI) WebhookGatewayInstallation(ctx context.Context, id int64) (githubapp.GatewayInstallation, githubquota.ResponseQuota, error) {
	a.calls = append(a.calls, id)
	if id == 10 {
		a.cancel()
		return githubapp.GatewayInstallation{}, githubquota.ResponseQuota{}, ctx.Err()
	}
	installation := a.installation
	installation.ID = id
	return installation, githubquota.ResponseQuota{}, nil
}

func TestAuthorityRefreshResumesAfterInterruptedSubscription(t *testing.T) {
	policy, job, receiver, dispatcher := authorityFixture()
	second := job.Subscription
	second.ID, second.Source.InstallationID = "second", 11
	policy.Subscriptions = append(policy.Subscriptions, second)
	policy.Revisions[second.ID] = policy.Revisions[job.Subscription.ID]
	grant := policy.Grants[job.Subscription.ID]
	grant.SubscriptionID, grant.SourceInstallationID, grant.ReceivingInstallationID = second.ID, 11, 11
	policy.Grants[second.ID] = grant
	state := authorityState{}
	api := &interruptedAuthorityAPI{authorityAPI: receiver}
	primer := AuthorityRefresher{Authority: LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{},
		Receiving: api, Dispatch: dispatcher, State: state}}
	for range 2 {
		ctx, cancel := context.WithCancel(t.Context())
		api.cancel = cancel
		err := primer.Refresh(ctx)
		cancel()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("interrupted refresh hid its error: %v", err)
		}
	}
	if !slices.Equal(api.calls, []int64{10, 11, 10}) || len(state[proofKey(second.ID)]) == 0 {
		t.Fatalf("repeated deadline starved later subscription: calls=%v", api.calls)
	}
	job.Subscription, job.SubscriptionDigest = second, policy.Revisions[second.ID].Digest
	proof, err := (ReceiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{}, State: state}).Authorize(t.Context(), job)
	if err != nil || !proof.Complete || !proof.SourceAccessible {
		t.Fatal("later subscription did not receive usable primed authority", err)
	}
}

func TestAuthorityRefreshHandlesCancelledEmptyAndChangedInventory(t *testing.T) {
	policy, _, receiver, dispatcher := authorityFixture()
	state := authorityState{}
	primer := AuthorityRefresher{Authority: LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{},
		Receiving: receiver, Dispatch: dispatcher, State: state}, next: 99}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if !errors.Is(primer.Refresh(ctx), context.Canceled) || len(state) != 0 {
		t.Fatal("cancelled refresh produced a proof")
	}
	if err := primer.Refresh(t.Context()); err != nil || len(state) != 1 {
		t.Fatal("changed subscription inventory broke cursor", err)
	}
	policy.Subscriptions = nil
	primer.Authority.Loader = authorityPolicy{policy}
	if err := primer.Refresh(t.Context()); err != nil || primer.next != 0 {
		t.Fatal("empty inventory did not reset primer cursor", err)
	}
}
