package webhookgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxPolicyBytes = 4 << 20

// CompiledArtifact is a control-plane approval of exact compiler output, not
// provenance asserted by the subscription itself.
type CompiledArtifact struct {
	Path         string `json:"path"`
	SHA256       string `json:"sha256"`
	RepositoryID int64  `json:"repositoryId"`
	CommitSHA    string `json:"commitSha"`
	CompilerID   string `json:"compilerId"`
}

type GatewayPolicy struct {
	Version            int                 `json:"version"`
	Enabled            bool                `json:"enabled"`
	Revision           int64               `json:"revision"`
	ReceivingAppID     int64               `json:"receivingAppId"`
	DispatchAppID      int64               `json:"dispatchAppId"`
	Namespace          string              `json:"namespace"`
	Artifacts          []CompiledArtifact  `json:"artifacts"`
	Grants             []AdminGrant        `json:"grants"`
	Queue              QueueOptions        `json:"queue"`
	Workers            int                 `json:"workers"`
	Discovery          *DiscoveryPolicy    `json:"discovery,omitempty"`
	ProjectAssignments []ProjectAssignment `json:"projectAssignments,omitempty"`
	ExternalSources    []ExternalSource    `json:"externalSources,omitempty"`
}

type PolicySnapshot struct {
	Policy        GatewayPolicy
	Revision      QueueRevision
	Subscriptions []Subscription
	Grants        map[string]AdminGrant
	Revisions     map[string]Revision
	AllowedOwners []string
	AllowedRepos  []string
}

// PolicyLoader reloads reviewed authority on every use. It deliberately has no
// last-known-good fallback when the file disappears or becomes invalid.
type PolicyLoader struct {
	Path  string
	cache *policyCache
}

type policyCache struct {
	sync.Mutex
	snapshot PolicySnapshot
}

func NewPolicyLoader(path string) PolicyLoader {
	return PolicyLoader{Path: path, cache: &policyCache{}}
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("gateway configuration is unavailable or oversized")
	}
	return data, nil
}

func strictDecode(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid gateway configuration")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("invalid trailing gateway configuration")
	}
	return nil
}

func sha256Text(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (l PolicyLoader) Load(ctx context.Context) (PolicySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return PolicySnapshot{}, err
	}
	if !filepath.IsAbs(l.Path) {
		return PolicySnapshot{}, errors.New("gateway policy path must be absolute")
	}
	file, err := os.Open(l.Path)
	if err != nil {
		return PolicySnapshot{}, errors.New("gateway policy is unavailable")
	}
	data, readErr := readBounded(file, maxPolicyBytes)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return PolicySnapshot{}, errors.New("gateway policy could not be read")
	}
	var document struct {
		Version      int `json:"version"`
		ControlPlane struct {
			Gateway json.RawMessage `json:"webhook-gateway"`
			Scope   struct {
				Owners []string `json:"allowed-owners"`
				Repos  []string `json:"allowed-repositories"`
			} `json:"scope"`
		} `json:"control-plane"`
	}
	policyLimits := DefaultLimits()
	policyLimits.MaxArrayItems = MaxDiscoveryRepositories
	if _, err := boundedJSON(data, maxPolicyBytes, policyLimits); err != nil {
		return PolicySnapshot{}, errors.New("invalid or excessively complex gateway policy")
	}
	if json.Unmarshal(data, &document) != nil || document.Version != 1 || len(document.ControlPlane.Gateway) == 0 {
		return PolicySnapshot{}, errors.New("gateway requires control-plane.webhook-gateway")
	}
	var policy GatewayPolicy
	if err := strictDecode(document.ControlPlane.Gateway, &policy); err != nil {
		return PolicySnapshot{}, err
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(document.ControlPlane.Gateway, &fields) != nil {
		return PolicySnapshot{}, ErrInvalid
	}
	for _, name := range []string{"discovery", "projectAssignments", "externalSources"} {
		if bytes.Equal(bytes.TrimSpace(fields[name]), []byte("null")) {
			return PolicySnapshot{}, ErrInvalid
		}
	}
	if policy.Queue == (QueueOptions{}) {
		policy.Queue = defaultGatewayQueueOptions()
	}
	if err := validateGatewayPolicy(policy); err != nil {
		return PolicySnapshot{}, err
	}
	normalized, err := json.Marshal(struct {
		Gateway GatewayPolicy `json:"gateway"`
		Owners  []string      `json:"owners"`
		Repos   []string      `json:"repositories"`
	}{policy, document.ControlPlane.Scope.Owners, document.ControlPlane.Scope.Repos})
	if err != nil {
		return PolicySnapshot{}, errors.New("gateway policy could not be normalized")
	}
	result := PolicySnapshot{
		Policy: policy, Revision: QueueRevision{Revision: policy.Revision, Digest: sha256Text(normalized), Enabled: policy.Enabled},
		Grants: make(map[string]AdminGrant), Revisions: make(map[string]Revision),
		AllowedOwners: document.ControlPlane.Scope.Owners, AllowedRepos: document.ControlPlane.Scope.Repos,
	}
	if policy.Discovery != nil {
		for _, repository := range policy.Discovery.Repositories {
			if !result.RepositoryAllowed(repository.Repository) {
				return PolicySnapshot{}, errors.New("gateway discovery repository is outside reviewed scope")
			}
		}
	}
	if l.cache != nil {
		l.cache.Lock()
		defer l.cache.Unlock()
		existing := l.cache.snapshot.Policy
		if l.cache.snapshot.Revision.Revision > 0 &&
			(existing.Namespace != policy.Namespace || existing.ReceivingAppID != policy.ReceivingAppID ||
				existing.DispatchAppID != policy.DispatchAppID || existing.Queue != policy.Queue || existing.Workers != policy.Workers ||
				(existing.Discovery == nil) != (policy.Discovery == nil)) {
			return PolicySnapshot{}, errors.New("gateway deployment identity or capacity change requires restart")
		}
		if l.cache.snapshot.Revision == result.Revision {
			return l.cache.snapshot, nil
		}
	}
	for _, grant := range policy.Grants {
		if grant.SubscriptionID == "" || result.Grants[grant.SubscriptionID].SubscriptionID != "" {
			return PolicySnapshot{}, errors.New("gateway grant identity is missing or duplicated")
		}
		result.Grants[grant.SubscriptionID] = grant
	}
	root, err := os.OpenRoot(filepath.Dir(l.Path))
	if err != nil {
		return PolicySnapshot{}, errors.New("gateway artifact root is unavailable")
	}
	defer func() { _ = root.Close() }()
	totalMetadata := 0
	for _, artifact := range policy.Artifacts {
		if err := ctx.Err(); err != nil {
			return PolicySnapshot{}, err
		}
		subscription, revision, err := loadArtifact(root, artifact)
		if err != nil {
			return PolicySnapshot{}, err
		}
		if subscription.Compiler != nil || subscription.Source.ID == CompilerSourceID || subscription.Source.External != nil {
			return PolicySnapshot{}, errors.New("gateway compiler subscriptions require the managed registry")
		}
		if _, external := result.ExternalSource(subscription.Source.ID); external {
			return PolicySnapshot{}, errors.New("gateway source identity conflicts with external enrollment")
		}
		if subscription.AppID != policy.DispatchAppID {
			return PolicySnapshot{}, errors.New("gateway subscription dispatch identity is not approved")
		}
		encoded, err := json.Marshal(subscription)
		if err != nil {
			return PolicySnapshot{}, errors.New("invalid gateway subscription")
		}
		totalMetadata += len(encoded)
		if totalMetadata > 16<<20 {
			return PolicySnapshot{}, errors.New("gateway subscription inventory exceeds memory budget")
		}
		grant, approved := result.Grants[subscription.ID]
		if result.Revisions[subscription.ID].Digest != "" || !approved || grant.Digest != revision.Digest {
			return PolicySnapshot{}, errors.New("gateway artifact lacks a unique exact administrative approval")
		}
		result.Subscriptions = append(result.Subscriptions, subscription)
		result.Revisions[subscription.ID] = revision
	}
	if l.cache != nil {
		if l.cache.snapshot.Revision.Revision > 0 {
			for _, source := range policy.ExternalSources {
				if _, found := l.cache.snapshot.ExternalSource(source.ID); !found {
					return PolicySnapshot{}, errors.New("gateway receiving source addition requires restart")
				}
			}
			sources := make(map[string]bool)
			for _, subscription := range l.cache.snapshot.Subscriptions {
				sources[subscription.Source.ID] = true
			}
			for _, subscription := range result.Subscriptions {
				if !sources[subscription.Source.ID] {
					return PolicySnapshot{}, errors.New("gateway receiving source addition requires restart")
				}
			}
		}
		l.cache.snapshot = result
	}
	return result, nil
}

func validateGatewayPolicy(p GatewayPolicy) error {
	if p.Version != 1 || p.Revision < 1 || p.ReceivingAppID <= 0 || p.DispatchAppID <= 0 ||
		p.ReceivingAppID == p.DispatchAppID || !identifier(p.Namespace) || len(p.Namespace) > 128 ||
		p.Workers < 1 || p.Workers > 32 ||
		len(p.Artifacts) > 1024 || len(p.Grants) > 1024 {
		return errors.New("invalid gateway identity, version, or operational limits")
	}
	if err := ValidateDiscoveryPolicy(p); err != nil {
		return err
	}
	if err := validateExternalSources(p); err != nil {
		return err
	}
	return ValidateQueueOptions(p.Queue)
}

func defaultGatewayQueueOptions() QueueOptions {
	perMinute := func(capacity int) RateBudget {
		return RateBudget{Capacity: capacity, Period: time.Minute}
	}
	return QueueOptions{
		MaxRows: 10000, MaxBytes: 64 << 20, MaxTenantRows: 1000, MaxTenantBytes: 8 << 20,
		MaxSourceRows: 1000, MaxSourceBytes: 8 << 20, MaxDestinationRows: 1000, MaxDestinationBytes: 8 << 20,
		MaxPayloadBytes: 1 << 20, MaxBatch: 64, MaxConcurrency: 8,
		MaxAge: 24 * time.Hour, DedupWindow: 72 * time.Hour, TerminalRetention: 72 * time.Hour, LeaseDuration: time.Minute,
		Rates: RateBudgets{Global: perMinute(60), App: perMinute(30), Tenant: perMinute(10), Destination: perMinute(10), Workflow: perMinute(5)},
	}
}

func loadArtifact(root *os.Root, artifact CompiledArtifact) (Subscription, Revision, error) {
	var empty Subscription
	var revision Revision
	if !filepath.IsLocal(artifact.Path) || len(artifact.SHA256) != 64 ||
		artifact.RepositoryID <= 0 || len(artifact.CommitSHA) != 40 || artifact.CompilerID == "" || len(artifact.CompilerID) > 128 {
		return empty, revision, errors.New("invalid gateway compiler provenance")
	}
	if _, err := hex.DecodeString(artifact.SHA256); err != nil {
		return empty, revision, errors.New("invalid gateway artifact digest")
	}
	if _, err := hex.DecodeString(artifact.CommitSHA); err != nil {
		return empty, revision, errors.New("invalid gateway artifact commit")
	}
	file, err := root.Open(artifact.Path)
	if err != nil {
		return empty, revision, errors.New("gateway compiled artifact is unavailable")
	}
	data, readErr := readBounded(file, 1<<20)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || sha256Text(data) != artifact.SHA256 {
		return empty, revision, errors.New("gateway compiled artifact integrity check failed")
	}
	subscription, err := ParseSubscription(data, DefaultLimits())
	if err != nil {
		return empty, revision, errors.New("gateway compiled subscription is invalid")
	}
	revision = Revision{
		RepositoryID: artifact.RepositoryID, CommitSHA: artifact.CommitSHA,
		MetadataPath: artifact.Path, Digest: artifact.SHA256, CompilerID: artifact.CompilerID,
	}
	return subscription, revision, nil
}

func (s PolicySnapshot) RepositoryAllowed(fullName string) bool {
	owner, name, ok := strings.Cut(fullName, "/")
	if !ok || name == "" || strings.Contains(name, "/") {
		return false
	}
	if len(s.AllowedOwners) > 0 && !s.OwnerAllowed(owner) {
		return false
	}
	for _, allowed := range s.AllowedRepos {
		if strings.EqualFold(fullName, allowed) {
			return true
		}
	}
	return len(s.AllowedRepos) == 0 && s.OwnerAllowed(owner)
}

func (s PolicySnapshot) OwnerAllowed(owner string) bool {
	for _, allowed := range s.AllowedOwners {
		if strings.EqualFold(owner, allowed) {
			return true
		}
	}
	return false
}
