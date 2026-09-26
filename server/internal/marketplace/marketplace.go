// Package marketplace resolves the read-only campaign package catalog
// described in specs/marketplace.md for the hosted Go dashboard backend.
//
// It mirrors activity/marketplace.mjs so both backends return the same safe
// package DTO from the same ordered registries: registries are read from the
// CAO policy (control-plane.marketplace), each is resolved independently so
// one registry's failure never affects another, and normalized results are
// safe to cache and to serve to dashboard clients because they never carry
// secret values or access tokens.
package marketplace

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

// SourceName is the canonical dashboard source name the query engine and
// generation loader use to request the marketplace catalog.
const SourceName = "marketplace-packages"

// DefaultCacheTTL applies when the policy omits or sets an invalid
// cache-ttl-seconds value.
const DefaultCacheTTL = 5 * time.Minute

const (
	maxPolicyBytes         = 4 << 20 // 4 MiB: cao.json is small; this bounds a misconfigured or hostile policy file.
	maxManifestBytes       = 256 * 1024
	maxPackagesPerRegistry = 500
)

// internalPackages are catalog-owned directories that are never themselves
// installable packages.
var internalPackages = map[string]bool{"activity": true, "dashboard": true}

// AuthType enumerates the supported registry authentication modes.
type AuthType string

const (
	AuthNone      AuthType = "none"
	AuthPAT       AuthType = "pat"
	AuthGitHubApp AuthType = "github-app"
)

// Auth describes how a registry authenticates. Every field below other than
// Type is an environment variable *name*, never a secret value: resolvers
// read the named variable from the trusted hosted backend's own environment.
type Auth struct {
	Type                 AuthType `json:"type"`
	Secret               string   `json:"secret,omitempty"`
	AppIDSecret          string   `json:"app-id-secret,omitempty"`
	PrivateKeySecret     string   `json:"private-key-secret,omitempty"`
	InstallationIDSecret string   `json:"installation-id-secret,omitempty"`
}

// Registry is one ordered marketplace source. Earlier registries have higher
// precedence when two registries expose the same package coordinate.
type Registry struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	Repository string `json:"repository"`
	Path       string `json:"path,omitempty"`
	Ref        string `json:"ref"`
	APIURL     string `json:"api-url,omitempty"`
	Auth       Auth   `json:"auth,omitempty"`
}

// Config is the parsed control-plane.marketplace policy section.
type Config struct {
	CacheTTL   time.Duration
	Registries []Registry
}

// Package is the normalized, safe package DTO shared with activity/marketplace.mjs.
type Package struct {
	ID                 string   `json:"id"`
	RegistryID         string   `json:"registry-id"`
	RegistryName       string   `json:"registry-name"`
	RegistryPrecedence int      `json:"registry-precedence"`
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	Publisher          string   `json:"publisher"`
	Repository         string   `json:"repository"`
	Path               string   `json:"path"`
	Ref                string   `json:"ref"`
	ResolvedCommit     string   `json:"resolved-commit"`
	Version            string   `json:"version"`
	Icon               string   `json:"icon"`
	Artwork            string   `json:"artwork"`
	Contents           []string `json:"contents"`
	Source             string   `json:"source"`
	AddCommand         string   `json:"add-command"`
}

// Row converts the package to a dashboard row. Field names are kebab-case to
// match the canonical data model used by every other source.
func (p Package) Row() model.Row {
	contents := p.Contents
	if contents == nil {
		contents = []string{}
	}
	return model.Row{
		"id":                  p.ID,
		"registry-id":         p.RegistryID,
		"registry-name":       p.RegistryName,
		"registry-precedence": p.RegistryPrecedence,
		"package-name":        p.Name,
		"package-description": p.Description,
		"publisher":           p.Publisher,
		"repository":          p.Repository,
		"path":                p.Path,
		"package-ref":         p.Ref,
		"resolved-commit":     p.ResolvedCommit,
		"package-version":     p.Version,
		"package-icon":        p.Icon,
		"package-artwork":     p.Artwork,
		"package-contents":    contents,
		"package-source":      p.Source,
		"add-command":         p.AddCommand,
	}
}

// RegistryDiagnostic reports one registry's resolution outcome without any
// credential-derived detail.
type RegistryDiagnostic struct {
	RegistryID string `json:"registry-id"`
	Status     string `json:"status"`
	Packages   int    `json:"packages,omitempty"`
	Message    string `json:"message,omitempty"`
}

// Row converts the diagnostic to a dashboard-safe row.
func (d RegistryDiagnostic) Row() model.Row {
	row := model.Row{"registry-id": d.RegistryID, "status": d.Status}
	if d.Status == "available" {
		row["packages"] = d.Packages
	}
	if d.Message != "" {
		row["message"] = d.Message
	}
	return row
}

// Result is the outcome of resolving every configured registry.
type Result struct {
	Packages    []Package
	Diagnostics []RegistryDiagnostic
}

type policyDocument struct {
	ControlPlane struct {
		Marketplace *marketplaceSection `json:"marketplace"`
	} `json:"control-plane"`
}

type marketplaceSection struct {
	CacheTTLSeconds int        `json:"cache-ttl-seconds"`
	Registries      []Registry `json:"registries"`
}

// ParseConfig reads the control-plane.marketplace section out of a full CAO
// policy document. A policy without a marketplace section resolves to zero
// registries rather than an error, matching the catalog's opt-in schema.
func ParseConfig(data []byte) (*Config, error) {
	if len(data) > maxPolicyBytes {
		return nil, fmt.Errorf("CAO policy exceeds %d bytes", maxPolicyBytes)
	}
	var document policyDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("parse CAO policy: %w", err)
	}
	if document.ControlPlane.Marketplace == nil {
		return &Config{Registries: []Registry{}}, nil
	}
	section := document.ControlPlane.Marketplace
	ttl := time.Duration(section.CacheTTLSeconds) * time.Second
	registries := section.Registries
	if registries == nil {
		registries = []Registry{}
	}
	return &Config{CacheTTL: ttl, Registries: registries}, nil
}

// LoadConfigFile reads and parses the CAO policy at path.
func LoadConfigFile(path string) (*Config, error) {
	// #nosec G304 -- path is an operator-controlled policy location (a flag/env
	// default), not user input.
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read CAO policy %q: %w", path, err)
	}
	return ParseConfig(data)
}

var (
	registryIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`)
	secretNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
	safePathCharset   = regexp.MustCompile(`^[A-Za-z0-9._/-]*$`)
	commitPattern     = regexp.MustCompile(`(?i)^[0-9a-f]{40}$`)
)

// isSafePath rejects absolute paths, disallowed characters, and any ".."
// path segment. Go's RE2 engine has no lookahead, so this is checked in code
// instead of by a single regular expression as activity/marketplace.mjs does.
func isSafePath(value string) bool {
	if strings.HasPrefix(value, "/") {
		return false
	}
	if !safePathCharset.MatchString(value) {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

// ValidateRegistry checks structural and authentication-reference safety and
// returns a normalized copy (trimmed path, defaulted name). It never reads
// secrets; it only checks that auth fields *look like* environment variable
// names.
func ValidateRegistry(registry Registry, index int) (Registry, error) {
	if !registryIDPattern.MatchString(registry.ID) {
		return Registry{}, fmt.Errorf("registry %d id is invalid", index)
	}
	if !repositoryPattern.MatchString(registry.Repository) {
		return Registry{}, fmt.Errorf("registry %s repository is invalid", registry.ID)
	}
	if strings.TrimSpace(registry.Ref) == "" {
		return Registry{}, fmt.Errorf("registry %s ref is required", registry.ID)
	}
	path := strings.Trim(registry.Path, "/")
	if !isSafePath(path) {
		return Registry{}, fmt.Errorf("registry %s path is invalid", registry.ID)
	}
	if registry.APIURL != "" && !strings.HasPrefix(registry.APIURL, "https://") {
		return Registry{}, fmt.Errorf("registry %s api-url must use https", registry.ID)
	}
	if err := validateAuth(registry.Auth); err != nil {
		return Registry{}, fmt.Errorf("registry %s auth: %w", registry.ID, err)
	}
	normalized := registry
	normalized.Path = path
	if normalized.Name == "" {
		normalized.Name = registry.ID
	}
	return normalized, nil
}

func validateAuth(auth Auth) error {
	switch auth.Type {
	case "", AuthNone:
		return nil
	case AuthPAT:
		if !secretNamePattern.MatchString(auth.Secret) {
			return fmt.Errorf("pat secret must reference an environment variable name")
		}
		return nil
	case AuthGitHubApp:
		for _, value := range []string{auth.AppIDSecret, auth.PrivateKeySecret, auth.InstallationIDSecret} {
			if !secretNamePattern.MatchString(value) {
				return fmt.Errorf("github-app secrets must reference environment variable names")
			}
		}
		return nil
	default:
		return fmt.Errorf("authentication type %q is unsupported", auth.Type)
	}
}

// apiBase returns the registry's GitHub REST API base URL with any trailing
// slash removed, defaulting to github.com.
func apiBase(registry Registry) string {
	base := registry.APIURL
	if base == "" {
		base = "https://api.github.com"
	}
	return strings.TrimRight(base, "/")
}

func fallbackRegistryID(registry Registry, index int) string {
	if registry.ID != "" {
		return registry.ID
	}
	return fmt.Sprintf("registry-%d", index)
}

// safeDiagnosticMessage renders err for a registry diagnostic with any secret
// *value* referenced by the registry's auth configuration redacted first,
// mirroring safeDiagnostic in activity/marketplace.mjs. This matters even
// though resolvers never intentionally return secrets: an underlying HTTP
// client or upstream API can otherwise echo a token/PAT/private-key back into
// an error message (e.g. via a URL or transport error), and diagnostics are
// exposed to dashboard clients.
func safeDiagnosticMessage(err error, registry Registry, opts Options) string {
	message := err.Error()
	env := opts.env()
	for _, name := range authSecretNames(registry.Auth) {
		if name == "" {
			continue
		}
		if value, ok := env(name); ok && value != "" {
			message = strings.ReplaceAll(message, value, "[redacted]")
		}
	}
	if len(message) > 500 {
		return message[:500]
	}
	return message
}

func authSecretNames(auth Auth) []string {
	return []string{auth.Secret, auth.AppIDSecret, auth.PrivateKeySecret, auth.InstallationIDSecret}
}

// Resolve resolves every configured registry in order, isolating failures
// into diagnostics, and returns the deduplicated, precedence-sorted package
// catalog. generation isolates the Cache by dashboard data revision so a
// cached result from one revision is never served under another. cache may be
// nil to disable caching.
func Resolve(ctx context.Context, config *Config, generation string, cache Cache, opts Options) *Result {
	if config == nil {
		return &Result{Packages: []Package{}, Diagnostics: []RegistryDiagnostic{}}
	}
	ttl := config.CacheTTL
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	var packages []Package
	diagnostics := make([]RegistryDiagnostic, 0, len(config.Registries))
	for index, raw := range config.Registries {
		registry, err := ValidateRegistry(raw, index)
		if err != nil {
			diagnostics = append(diagnostics, RegistryDiagnostic{
				RegistryID: fallbackRegistryID(raw, index), Status: "unavailable", Message: safeDiagnosticMessage(err, raw, opts),
			})
			continue
		}
		if cached, hit := loadCachedRegistry(ctx, cache, registry.ID, generation); hit {
			packages = append(packages, cached...)
			diagnostics = append(diagnostics, RegistryDiagnostic{RegistryID: registry.ID, Status: "available", Packages: len(cached)})
			continue
		}
		resolved, err := ResolveRegistry(ctx, registry, index, opts)
		if err != nil {
			diagnostics = append(diagnostics, RegistryDiagnostic{
				RegistryID: registry.ID, Status: "unavailable", Message: safeDiagnosticMessage(err, registry, opts),
			})
			continue
		}
		storeCachedRegistry(ctx, cache, registry.ID, generation, ttl, resolved)
		packages = append(packages, resolved...)
		diagnostics = append(diagnostics, RegistryDiagnostic{RegistryID: registry.ID, Status: "available", Packages: len(resolved)})
	}
	return &Result{Packages: sortAndDedupe(packages), Diagnostics: diagnostics}
}

func sortAndDedupe(packages []Package) []Package {
	sort.SliceStable(packages, func(i, j int) bool {
		left, right := packages[i], packages[j]
		if left.RegistryPrecedence != right.RegistryPrecedence {
			return left.RegistryPrecedence < right.RegistryPrecedence
		}
		if left.Repository != right.Repository {
			return left.Repository < right.Repository
		}
		return left.Path < right.Path
	})
	seen := map[string]bool{}
	ordered := make([]Package, 0, len(packages))
	for _, entry := range packages {
		coordinate := strings.ToLower(entry.Repository + "/" + entry.Path)
		if seen[coordinate] {
			continue
		}
		seen[coordinate] = true
		ordered = append(ordered, entry)
	}
	return ordered
}
