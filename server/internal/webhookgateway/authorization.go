package webhookgateway

import (
	"slices"
	"time"
)

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[string]bool, len(a))
	for _, id := range a {
		if !nodeID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	for _, id := range b {
		if !seen[id] {
			return false
		}
		delete(seen, id)
	}
	return len(seen) == 0
}

func visibilityRank(v string) int {
	switch v {
	case "public":
		return 0
	case "internal":
		return 1
	case "private":
		return 2
	default:
		return -1
	}
}

// Authorize intersects fresh observed access with a separate exact-digest administrative grant.
// The shell must perform new live checks for each attempt; expiry is not permission to cache them.
func Authorize(now time.Time, s Subscription, expectedDigest string, event Event, snapshot AuthorizationSnapshot) (AuthorizationDecision, error) {
	return authorize(now, s, expectedDigest, event, snapshot, true)
}

func authorize(now time.Time, s Subscription, expectedDigest string, event Event, snapshot AuthorizationSnapshot, checkPayload bool) (AuthorizationDecision, error) {
	if err := ValidateSubscription(s, DefaultLimits()); err != nil {
		return AuthorizationDecision{}, err
	}
	if now.IsZero() || !digestOK(expectedDigest) {
		return AuthorizationDecision{}, ErrInvalid
	}
	deferDecision := AuthorizationDecision{Reason: "authorization-incomplete"}
	cancel := func(reason string) (AuthorizationDecision, error) {
		return AuthorizationDecision{Cancel: true, Reason: reason}, nil
	}
	if !snapshot.Complete || snapshot.CheckedAt.IsZero() || snapshot.CheckedAt.After(now) ||
		!snapshot.ExpiresAt.After(now) || !snapshot.ExpiresAt.After(snapshot.CheckedAt) ||
		snapshot.ExpiresAt.Sub(snapshot.CheckedAt) > 30*time.Second {
		return deferDecision, nil
	}
	if !validRevision(snapshot.CurrentRevision) {
		return deferDecision, nil
	}
	if snapshot.CurrentRevision.Digest != expectedDigest {
		return cancel("subscription-revision-changed")
	}
	src, dst, grant := s.Source, s.Destination, snapshot.Grant
	externalID := ""
	if src.External != nil {
		externalID = src.ID
		if !now.Before(src.External.ExpiresAt) {
			return cancel("source-enrollment-expired")
		}
	}
	eventOK := event.Name == src.Event
	if checkPayload && s.Compiler != nil && githubHTMLFamily(src.Event) {
		eventOK = slices.Contains(s.Compiler.NativeEvents, event.Name)
	}
	if event.SourceID != src.ID || !eventOK ||
		snapshot.ExternalSourceID != externalID || grant.ExternalSourceID != externalID ||
		event.InstallationID != src.InstallationID ||
		snapshot.SourceInstallationID != src.InstallationID ||
		snapshot.ReceivingInstallationID != src.InstallationID ||
		event.RepositoryID != src.RepositoryID || snapshot.SourceRepositoryID != src.RepositoryID ||
		(src.OrganizationID != 0 && (event.OrganizationID != src.OrganizationID || snapshot.SourceOrganizationID != src.OrganizationID)) ||
		snapshot.DestinationInstallationID != dst.InstallationID ||
		snapshot.DestinationRepositoryID != dst.RepositoryID {
		return cancel("identity-changed")
	}
	if !snapshot.SourceAccessible || !snapshot.DestinationAccessible {
		return cancel("access-withdrawn")
	}
	if !snapshot.SourcePermissionsOK || !snapshot.DispatchPermissionsOK {
		return cancel("permissions-withdrawn")
	}
	if grant.Revoked || !grant.ExpiresAt.After(now) ||
		grant.SubscriptionID != s.ID || grant.Digest != expectedDigest ||
		grant.SourceInstallationID != src.InstallationID ||
		grant.SourceRepositoryID != src.RepositoryID ||
		grant.SourceOrganizationID != src.OrganizationID ||
		!sameIDs(grant.ProjectIDs, src.ProjectIDs) ||
		grant.ReceivingInstallationID != snapshot.ReceivingInstallationID ||
		grant.DestinationInstallationID != dst.InstallationID ||
		grant.DestinationRepositoryID != dst.RepositoryID || grant.DispatchKind != dst.Kind {
		return cancel("grant-withdrawn")
	}
	sourceVisibility := visibilityRank(snapshot.SourceVisibility)
	destinationVisibility := visibilityRank(snapshot.DestinationVisibility)
	if sourceVisibility < 0 || destinationVisibility < 0 {
		return deferDecision, nil
	}
	if sourceVisibility > destinationVisibility && !grant.AllowVisibilityTransfer {
		return cancel("visibility-transfer-denied")
	}
	if checkPayload {
		matched, err := MatchSubscription(s, event, DefaultLimits())
		if err != nil {
			return AuthorizationDecision{}, err
		}
		if !matched {
			return cancel("subscription-no-longer-matches")
		}
	}
	return AuthorizationDecision{Allowed: true, Reason: "authorized"}, nil
}

// ValidateAuthorization binds fresh evidence to this claim and its next dispatch attempt.
func ValidateAuthorization(now time.Time, j Job, snapshot AuthorizationSnapshot) (AuthorizationDecision, error) {
	if snapshot.JobID != j.ID || snapshot.Fence != j.Fence || snapshot.Attempt != j.Attempt+1 {
		return AuthorizationDecision{Reason: "authorization-claim-mismatch"}, nil
	}
	if !validEventIdentity(j.Event, j.Subscription) || j.Event.DeliveryID != j.DeliveryID {
		return AuthorizationDecision{}, ErrInvalid
	}
	return authorize(now, j.Subscription, j.SubscriptionDigest, j.Event.event(), snapshot, false)
}

// ValidateDispatchAuthorization is the pure gate invoked inside the queue's CAS transaction.
func ValidateDispatchAuthorization(job Job, authorization Authorization, now time.Time) error {
	if job.State != Claimed || !job.ExpiresAt.After(now) || !job.LeaseUntil.After(now) ||
		!authorization.Revision.Enabled || authorization.Revision != job.QueueRevision ||
		authorization.ApprovedSubscriptionDigest != job.SubscriptionDigest {
		return ErrUnauthorized
	}
	decision, err := ValidateAuthorization(now, job, authorization.Snapshot)
	if err != nil {
		return err
	}
	if !decision.Allowed {
		return ErrUnauthorized
	}
	return nil
}
