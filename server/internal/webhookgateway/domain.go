// Package webhookgateway defines bounded webhook subscriptions and pure dispatch decisions.
package webhookgateway

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Domain errors deliberately carry no webhook contents or upstream error bodies.
var (
	ErrInvalid        = errors.New("invalid webhook gateway input")
	ErrConflict       = errors.New("webhook gateway conflict")
	ErrCapacity       = errors.New("webhook gateway capacity")
	ErrNotFound       = errors.New("webhook gateway job not found")
	ErrUnauthorized   = errors.New("webhook gateway authorization incomplete")
	ErrUnavailable    = errors.New("webhook gateway unavailable")
	ErrRequestNotSent = errors.New("webhook gateway request was not sent")
	ErrQueueInvalid   = ErrInvalid
	ErrQueueConflict  = ErrConflict
	ErrQueueCapacity  = ErrCapacity
	ErrQueueNotFound  = ErrNotFound
)

// Event contains common GitHub identities; SourceID is assigned by the trusted ingress route.
type Event struct {
	SourceID       string          `json:"sourceId"`
	DeliveryID     string          `json:"deliveryId"`
	Name           string          `json:"name"`
	Action         string          `json:"action"`
	InstallationID int64           `json:"installationId"`
	RepositoryID   int64           `json:"repositoryId"`
	OrganizationID int64           `json:"organizationId"`
	Payload        json.RawMessage `json:"payload"`
}

// EventIdentity retains only signed common identities, never the webhook body.
type EventIdentity struct {
	SourceID       string `json:"sourceId"`
	DeliveryID     string `json:"deliveryId"`
	Name           string `json:"name"`
	Action         string `json:"action,omitempty"`
	InstallationID int64  `json:"installationId"`
	RepositoryID   int64  `json:"repositoryId,omitempty"`
	OrganizationID int64  `json:"organizationId,omitempty"`
}

// IdentityOf copies the non-payload portion of a verified event.
func IdentityOf(e Event) EventIdentity {
	return EventIdentity{SourceID: e.SourceID, DeliveryID: e.DeliveryID, Name: e.Name,
		Action: e.Action, InstallationID: e.InstallationID, RepositoryID: e.RepositoryID,
		OrganizationID: e.OrganizationID}
}

func (e EventIdentity) event() Event {
	return Event{SourceID: e.SourceID, DeliveryID: e.DeliveryID, Name: e.Name,
		Action: e.Action, InstallationID: e.InstallationID, RepositoryID: e.RepositoryID,
		OrganizationID: e.OrganizationID}
}

// Subscription is immutable compiler metadata, not an administrative grant.
type Subscription struct {
	SchemaVersion string `json:"schemaVersion"`
	Provider      string `json:"provider"`
	ID            string `json:"id"`
	TenantID      string `json:"tenantId"`
	// AppID is the dispatching GitHub App identity, not the receiving App.
	// Policy loading must bind it to the configured dispatch App ID.
	AppID       int64            `json:"appId"`
	Source      Source           `json:"source"`
	Filter      *Filter          `json:"filter,omitempty"`
	Destination Destination      `json:"destination"`
	Delivery    DeliveryPolicy   `json:"delivery"`
	Compiler    *CompilerTrigger `json:"compiler,omitempty"`
}

// Source selects one configured route and a bounded immutable GitHub scope.
type Source struct {
	ID                  string               `json:"id"`
	Event               string               `json:"event"`
	InstallationID      int64                `json:"installationId"`
	RepositoryID        int64                `json:"repositoryId,omitempty"`
	OrganizationID      int64                `json:"organizationId,omitempty"`
	ProjectIDs          []string             `json:"projectIds,omitempty"`
	IdentityConstraints []IdentityConstraint `json:"identityConstraints,omitempty"`
	RequiredPermissions map[string]string    `json:"requiredPermissions,omitempty"`
}

// IdentityConstraint is compiler-declared scalar equality or allowed-value membership,
// independent of event family. A nonempty array Value denotes allowed scalar values.
type IdentityConstraint struct {
	Path  string          `json:"path"`
	Value json.RawMessage `json:"value"`
}

// Destination permits only the two explicitly modeled GitHub dispatch APIs.
type Destination struct {
	Kind           string `json:"kind"`
	InstallationID int64  `json:"installationId"`
	RepositoryID   int64  `json:"repositoryId"`
	Workflow       string `json:"workflow,omitempty"`
	Ref            string `json:"ref,omitempty"`
	EventType      string `json:"eventType,omitempty"`
	// GatewayInput asserts that the compiled workflow declares the reserved _gateway input.
	GatewayInput bool `json:"gatewayInput,omitempty"`
	// BatchInput asserts all five reserved batch inputs are declared by the workflow.
	BatchInput bool           `json:"batchInput,omitempty"`
	Fields     []PayloadField `json:"fields"`
}

// PayloadField copies an allowlisted scalar/scalar array or a compiler literal
// into a named property. Webhook objects cannot be forwarded wholesale.
type PayloadField struct {
	Name     string          `json:"name"`
	Path     *string         `json:"path,omitempty"`
	Literal  json.RawMessage `json:"literal,omitempty"`
	Required bool            `json:"required"`
}

// DeliveryPolicy bounds lifetime, lease duration, attempts, and safe-response retry delay.
type DeliveryPolicy struct {
	TTLSeconds        int64  `json:"ttlSeconds"`
	LeaseSeconds      int64  `json:"leaseSeconds"`
	MaxAttempts       uint32 `json:"maxAttempts"`
	RetryDelaySeconds int64  `json:"retryDelaySeconds"`
}

// Filter is a strictly validated bounded expression.
type Filter struct {
	Op    string          `json:"op"`
	Path  string          `json:"path,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
	Args  []Filter        `json:"args,omitempty"`
}

// Truth keeps missing or incompatible operands unknown even beneath negation.
type Truth string

const (
	True    Truth = "true"
	False   Truth = "false"
	Unknown Truth = "unknown"
)

// Limits may tighten, but never expand, the hard implementation ceilings.
type Limits struct {
	MaxMetadataBytes      int `json:"maxMetadataBytes"`
	MaxEventBytes         int `json:"maxEventBytes"`
	MaxJSONDepth          int `json:"maxJsonDepth"`
	MaxJSONNodes          int `json:"maxJsonNodes"`
	MaxFilterDepth        int `json:"maxFilterDepth"`
	MaxFilterNodes        int `json:"maxFilterNodes"`
	MaxPathBytes          int `json:"maxPathBytes"`
	MaxPathSegments       int `json:"maxPathSegments"`
	MaxStringBytes        int `json:"maxStringBytes"`
	MaxArrayItems         int `json:"maxArrayItems"`
	MaxDispatchBytes      int `json:"maxDispatchBytes"`
	MaxDispatchProperties int `json:"maxDispatchProperties"`
}

// Revision identifies the trusted compiler artifact independently of rollout policy.
type Revision struct {
	RepositoryID int64  `json:"repositoryId"`
	CommitSHA    string `json:"commitSha"`
	MetadataPath string `json:"metadataPath"`
	Digest       string `json:"digest"`
	CompilerID   string `json:"compilerId"`
}

// AdminGrant is supplied by reviewed control policy, never by the metadata artifact.
type AdminGrant struct {
	SubscriptionID            string    `json:"subscriptionId"`
	Digest                    string    `json:"digest"`
	SourceInstallationID      int64     `json:"sourceInstallationId"`
	SourceRepositoryID        int64     `json:"sourceRepositoryId"`
	SourceOrganizationID      int64     `json:"sourceOrganizationId"`
	ProjectIDs                []string  `json:"projectIds,omitempty"`
	ReceivingInstallationID   int64     `json:"receivingInstallationId"`
	DestinationInstallationID int64     `json:"destinationInstallationId"`
	DestinationRepositoryID   int64     `json:"destinationRepositoryId"`
	DispatchKind              string    `json:"dispatchKind"`
	AllowVisibilityTransfer   bool      `json:"allowVisibilityTransfer"`
	ExpiresAt                 time.Time `json:"expiresAt"`
	Revoked                   bool      `json:"revoked"`
}

// AuthorizationSnapshot is fresh shell evidence bound to one claim and next attempt.
// Accessible=false with Complete=true means observed revocation; incomplete checks defer.
type AuthorizationSnapshot struct {
	CheckedAt                 time.Time  `json:"checkedAt"`
	ExpiresAt                 time.Time  `json:"expiresAt"`
	Complete                  bool       `json:"complete"`
	JobID                     string     `json:"jobId"`
	Fence                     uint64     `json:"fence"`
	Attempt                   uint32     `json:"attempt"`
	SourceInstallationID      int64      `json:"sourceInstallationId"`
	SourceRepositoryID        int64      `json:"sourceRepositoryId"`
	SourceOrganizationID      int64      `json:"sourceOrganizationId"`
	ReceivingInstallationID   int64      `json:"receivingInstallationId"`
	DestinationInstallationID int64      `json:"destinationInstallationId"`
	DestinationRepositoryID   int64      `json:"destinationRepositoryId"`
	SourceAccessible          bool       `json:"sourceAccessible"`
	DestinationAccessible     bool       `json:"destinationAccessible"`
	SourcePermissionsOK       bool       `json:"sourcePermissionsOk"`
	DispatchPermissionsOK     bool       `json:"dispatchPermissionsOk"`
	SourceVisibility          string     `json:"sourceVisibility"`
	DestinationVisibility     string     `json:"destinationVisibility"`
	CurrentRevision           Revision   `json:"currentRevision"`
	Grant                     AdminGrant `json:"grant"`
}

// AuthorizationDecision distinguishes observed withdrawal from incomplete evidence.
type AuthorizationDecision struct {
	Allowed bool   `json:"allowed"`
	Cancel  bool   `json:"cancel"`
	Reason  string `json:"reason"`
}

// JobState records dispatch knowledge, not workflow execution success.
type JobState string

const (
	Ready       JobState = "ready"
	Claimed     JobState = "claimed"
	Dispatching JobState = "dispatching"
	Succeeded   JobState = "succeeded"
	Expired     JobState = "expired"
	Rejected    JobState = "rejected"
	Cancelled   JobState = "cancelled"
	Failed      JobState = "failed"
	Ambiguous   JobState = "ambiguous"
)

// Job retains an immutable subscription, common identities, and compiled allowlisted request.
// Raw webhook bodies are never persisted; IDs exclude mutable revisions.
type Job struct {
	ID                 string          `json:"id"`
	DeliveryID         string          `json:"deliveryId"`
	Subscription       Subscription    `json:"subscription"`
	SubscriptionDigest string          `json:"subscriptionDigest"`
	Event              EventIdentity   `json:"event"`
	Payload            json.RawMessage `json:"payload"`
	QueueRevision      QueueRevision   `json:"queueRevision"`
	State              JobState        `json:"state"`
	Version            uint64          `json:"version"`
	Fence              uint64          `json:"fence"`
	ClaimID            string          `json:"claimId"`
	Attempt            uint32          `json:"attempt"`
	CreatedAt          time.Time       `json:"createdAt"`
	ExpiresAt          time.Time       `json:"expiresAt"`
	NotBefore          time.Time       `json:"notBefore"`
	LeaseUntil         time.Time       `json:"leaseUntil"`
	Reason             string          `json:"reason"`
	AcceptedStatus     int             `json:"acceptedStatus,omitempty"`
	WorkflowRunID      int64           `json:"workflowRunId,omitempty"`
	// TraceParent is locally generated correlation only; it never grants authority.
	TraceParent string `json:"traceParent,omitempty"`
}

// QueueRevision is a monotonic reviewed policy identity including the kill switch.
type QueueRevision struct {
	Revision int64  `json:"revision"`
	Digest   string `json:"digest"`
	Enabled  bool   `json:"enabled"`
}

// PolicyRevision is the same identity used by production policy configuration.
type PolicyRevision = QueueRevision

// Dimensions are stable budget partition keys derived solely from immutable subscription IDs.
type Dimensions struct {
	App         string `json:"app"`
	Tenant      string `json:"tenant"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Workflow    string `json:"workflow"`
}

// RateBudget bounds accepted dispatch attempts over a fixed period.
type RateBudget struct {
	Capacity int           `json:"capacity"`
	Period   time.Duration `json:"period"`
}

// RateBudgets intersects all five budget dimensions.
type RateBudgets struct {
	Global      RateBudget `json:"global"`
	App         RateBudget `json:"app"`
	Tenant      RateBudget `json:"tenant"`
	Destination RateBudget `json:"destination"`
	Workflow    RateBudget `json:"workflow"`
}

// QueueOptions fixes storage, retention, concurrency, and hierarchical rate ceilings.
type QueueOptions struct {
	MaxRows             int64         `json:"maxRows"`
	MaxBytes            int64         `json:"maxBytes"`
	MaxTenantRows       int64         `json:"maxTenantRows"`
	MaxTenantBytes      int64         `json:"maxTenantBytes"`
	MaxSourceRows       int64         `json:"maxSourceRows"`
	MaxSourceBytes      int64         `json:"maxSourceBytes"`
	MaxDestinationRows  int64         `json:"maxDestinationRows"`
	MaxDestinationBytes int64         `json:"maxDestinationBytes"`
	MaxPayloadBytes     int64         `json:"maxPayloadBytes"`
	MaxBatch            int           `json:"maxBatch"`
	MaxConcurrency      int           `json:"maxConcurrency"`
	MaxAge              time.Duration `json:"maxAge"`
	DedupWindow         time.Duration `json:"dedupWindow"`
	TerminalRetention   time.Duration `json:"terminalRetention"`
	LeaseDuration       time.Duration `json:"leaseDuration"`
	Rates               RateBudgets   `json:"rates"`
}

// Admission atomically deduplicates one delivery and its subscription jobs.
type Admission struct {
	Revision       QueueRevision `json:"revision"`
	DeliveryID     string        `json:"deliveryId"`
	DeliveryDigest string        `json:"deliveryDigest"`
	Jobs           []Job         `json:"jobs"`
}

// AdmissionResult reports the atomic admitted or previously admitted batch.
type AdmissionResult struct {
	Jobs      []Job `json:"jobs"`
	Duplicate bool  `json:"duplicate"`
}

// ClaimRequest identifies a worker without granting dispatch authority.
type ClaimRequest struct {
	Owner         string        `json:"owner"`
	LeaseDuration time.Duration `json:"leaseDuration"`
	BatchWindow   time.Duration `json:"batchWindow"`
}

// Fence is the exact owner, generation, and version required for a mutation.
type Fence struct {
	JobID      string `json:"jobId"`
	Owner      string `json:"owner"`
	Generation uint64 `json:"generation"`
	Version    uint64 `json:"version"`
}

// Authorization combines current policy approval with fresh live GitHub evidence.
type Authorization struct {
	Revision                   QueueRevision         `json:"revision"`
	ApprovedSubscriptionDigest string                `json:"approvedSubscriptionDigest"`
	Snapshot                   AuthorizationSnapshot `json:"snapshot"`
}

// Outcome may request Ready only for a known nonacceptance response, never uncertain transport.
type Outcome struct {
	State          JobState      `json:"state"`
	Reason         string        `json:"reason"`
	NotBefore      time.Time     `json:"notBefore"`
	AcceptedStatus int           `json:"acceptedStatus,omitempty"`
	WorkflowRunID  int64         `json:"workflowRunId,omitempty"`
	RetryJitter    time.Duration `json:"retryJitter,omitempty"`
}

// MaintenanceResult summarizes bounded durable recovery without raw event contents.
type MaintenanceResult struct {
	Recovered int `json:"recovered"`
	Ambiguous int `json:"ambiguous"`
	Expired   int `json:"expired"`
	Deleted   int `json:"deleted"`
}

// Queue implementations enforce atomic CAS, policy checks, capacity, and budget spending.
type Queue interface {
	AdmitBatch(context.Context, Admission) (AdmissionResult, error)
	Claim(context.Context, ClaimRequest) (*Job, error)
	Renew(context.Context, Fence, time.Duration) (Job, error)
	BeginDispatch(context.Context, Fence, Authorization) (Job, error)
	Finish(context.Context, Fence, Outcome) (Job, error)
	Cancel(context.Context, string, uint64) (Job, error)
	ApplyRevision(context.Context, QueueRevision) error
	Maintain(context.Context, int) (MaintenanceResult, error)
}

// DispatchResponse is a bounded transient HTTP observation, never persisted verbatim.
type DispatchResponse struct {
	Kind               string          `json:"kind"`
	StatusCode         int             `json:"statusCode"`
	Body               json.RawMessage `json:"body,omitempty"`
	RetryAfter         string          `json:"retryAfter,omitempty"`
	RateLimitRemaining string          `json:"rateLimitRemaining,omitempty"`
	RateLimitReset     string          `json:"rateLimitReset,omitempty"`
	TransportOutcome   string          `json:"transportOutcome"`
	WorkflowRunID      int64           `json:"workflowRunId,omitempty"`
}

// DispatchResult is safe to retain: reasons are fixed classifications, not upstream messages.
type DispatchResult struct {
	Outcome        string        `json:"outcome"`
	Reason         string        `json:"reason"`
	RetryAt        time.Time     `json:"retryAt"`
	AcceptedStatus int           `json:"acceptedStatus,omitempty"`
	WorkflowRunID  int64         `json:"workflowRunId,omitempty"`
	RetryJitter    time.Duration `json:"retryJitter,omitempty"`
}
