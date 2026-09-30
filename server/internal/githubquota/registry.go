package githubquota

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

var providerNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// BucketProvider is one configured, non-secret source of GitHub API quota:
// a named GitHub App identity with the installations and resources it can
// meter. Providers carry no credentials; credential resolution belongs to
// the GitHub client that later consumes a selected bucket.
type BucketProvider struct {
	// Name is the operator-facing provider name, such as "collector-primary".
	Name string `json:"name"`
	// App is the GitHub App identity used in the bucket identity.
	App string `json:"app"`
	// Installations are the installation IDs this provider can use.
	Installations []int64 `json:"installations"`
	// Resources are the rate-limit resources to meter. Empty selects core.
	Resources []string `json:"resources,omitempty"`
}

// Registry is the set of configured quota providers. It lets callers
// discover buckets for a workload without exposing credentials, and is
// defined independently of any scheduling policy.
type Registry struct {
	providers []BucketProvider
	byName    map[string]int
}

type registryDocument struct {
	Providers []BucketProvider `json:"providers"`
}

// ParseRegistry decodes a registry from JSON of the form
// {"providers":[{"name":"...","app":"...","installations":[...]}]}. Unknown
// fields are rejected so credential material cannot be smuggled into quota
// configuration.
func ParseRegistry(data []byte) (*Registry, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document registryDocument
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("decode github quota registry: %w", err)
	}
	if decoder.More() {
		return nil, errors.New("decode github quota registry: trailing data")
	}
	return NewRegistry(document.Providers...)
}

// NewRegistry validates and normalizes providers.
func NewRegistry(providers ...BucketProvider) (*Registry, error) {
	registry := &Registry{byName: make(map[string]int, len(providers))}
	for _, provider := range providers {
		normalized, err := normalizeProvider(provider)
		if err != nil {
			return nil, err
		}
		if _, exists := registry.byName[normalized.Name]; exists {
			return nil, fmt.Errorf("github quota provider %q is defined more than once", normalized.Name)
		}
		registry.byName[normalized.Name] = len(registry.providers)
		registry.providers = append(registry.providers, normalized)
	}
	return registry, nil
}

func normalizeProvider(provider BucketProvider) (BucketProvider, error) {
	provider.Name = strings.ToLower(strings.TrimSpace(provider.Name))
	if !providerNamePattern.MatchString(provider.Name) {
		return BucketProvider{}, errors.New("github quota provider name must contain 1-64 lowercase letters, digits, dots, underscores, or hyphens")
	}
	if len(provider.Installations) == 0 {
		return BucketProvider{}, fmt.Errorf("github quota provider %q requires at least one installation", provider.Name)
	}
	resources := provider.Resources
	if len(resources) == 0 {
		resources = []string{ResourceCore}
	}
	normalized := BucketProvider{Name: provider.Name}
	for _, installation := range provider.Installations {
		for _, resource := range resources {
			bucket, err := normalizeBucket(BucketID{App: provider.App, Installation: installation, Resource: resource})
			if err != nil {
				return BucketProvider{}, fmt.Errorf("github quota provider %q: %w", provider.Name, err)
			}
			normalized.App = bucket.App
			if !slices.Contains(normalized.Installations, installation) {
				normalized.Installations = append(normalized.Installations, installation)
			}
			if !slices.Contains(normalized.Resources, bucket.Resource) {
				normalized.Resources = append(normalized.Resources, bucket.Resource)
			}
		}
	}
	return normalized, nil
}

// Providers returns a copy of the configured providers in configuration order.
func (r *Registry) Providers() []BucketProvider {
	if r == nil {
		return nil
	}
	providers := make([]BucketProvider, 0, len(r.providers))
	for _, provider := range r.providers {
		provider.Installations = slices.Clone(provider.Installations)
		provider.Resources = slices.Clone(provider.Resources)
		providers = append(providers, provider)
	}
	return providers
}

// Provider returns a copy of one named provider.
func (r *Registry) Provider(name string) (BucketProvider, bool) {
	if r == nil {
		return BucketProvider{}, false
	}
	index, ok := r.byName[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return BucketProvider{}, false
	}
	provider := r.providers[index]
	provider.Installations = slices.Clone(provider.Installations)
	provider.Resources = slices.Clone(provider.Resources)
	return provider, true
}

// Buckets returns every bucket of the named providers, or of every provider
// when no names are supplied, deduplicated in configuration order. An
// unknown provider name fails closed.
func (r *Registry) Buckets(names ...string) ([]BucketID, error) {
	return r.collect(names, func(BucketID) bool { return true })
}

// BucketsFor returns the buckets of the named providers (or every provider)
// that meter the given installation and resource. An empty resource selects
// core. A repository may be reachable through several buckets; callers pass
// the result to Service.Select.
func (r *Registry) BucketsFor(installation int64, resource string, names ...string) ([]BucketID, error) {
	resource = strings.ToLower(strings.TrimSpace(resource))
	if resource == "" {
		resource = ResourceCore
	}
	return r.collect(names, func(bucket BucketID) bool {
		return bucket.Installation == installation && bucket.Resource == resource
	})
}

func (r *Registry) collect(names []string, include func(BucketID) bool) ([]BucketID, error) {
	if r == nil {
		return nil, errors.New("github quota registry is not configured")
	}
	selected := r.providers
	if len(names) > 0 {
		selected = make([]BucketProvider, 0, len(names))
		for _, name := range names {
			provider, ok := r.Provider(name)
			if !ok {
				return nil, fmt.Errorf("github quota provider %q is not configured", strings.TrimSpace(name))
			}
			selected = append(selected, provider)
		}
	}
	var buckets []BucketID
	seen := map[BucketID]struct{}{}
	for _, provider := range selected {
		for _, installation := range provider.Installations {
			for _, resource := range provider.Resources {
				bucket := BucketID{App: provider.App, Installation: installation, Resource: resource}
				if _, duplicate := seen[bucket]; duplicate || !include(bucket) {
					continue
				}
				seen[bucket] = struct{}{}
				buckets = append(buckets, bucket)
			}
		}
	}
	return buckets, nil
}
