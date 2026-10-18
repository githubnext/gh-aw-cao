package githubapp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/go-github/v66/github"
)

// ScopedToken is a GitHub App installation token restricted to explicit
// repositories and permissions. Its formatting methods redact the credential
// so it cannot be logged accidentally; only Secret exposes the value.
type ScopedToken struct {
	value          string
	InstallationID int64
	ExpiresAt      time.Time
	Repositories   []string
	Permissions    map[string]string
}

// ScopedTokenLifetime is GitHub's maximum installation-token lifetime. Cleanup
// can conservatively wait this long from receipt when expiry evidence is absent.
const ScopedTokenLifetime = time.Hour

// NewScopedToken constructs a token from an externally minted credential. It
// exists for tests and alternative brokers; production tokens come from
// MintScopedToken.
func NewScopedToken(value string, installationID int64, expiresAt time.Time) ScopedToken {
	return ScopedToken{value: value, InstallationID: installationID, ExpiresAt: expiresAt}
}

// Secret returns the credential for injection into one subprocess environment.
func (t ScopedToken) Secret() string { return t.value }

// Hashed returns GitHub's audit-log hashed_token form of the credential
// (base64 of its SHA-256 digest), which identifies the token in GitHub audit
// events without revealing it.
func (t ScopedToken) Hashed() string {
	if t.value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(t.value))
	return base64.StdEncoding.EncodeToString(digest[:])
}

func (t ScopedToken) String() string   { return "[REDACTED]" }
func (t ScopedToken) GoString() string { return "githubapp.ScopedToken{[REDACTED]}" }

func (t ScopedToken) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"installationId": t.InstallationID, "expiresAt": t.ExpiresAt})
}

// TokenScope is the least-privilege grant requested for one scoped token.
// Repositories are repository names (without the owner) inside the
// installation account. Permissions map GitHub App permission names such as
// "contents" to "read" or "write".
type TokenScope struct {
	Repositories []string
	Permissions  map[string]string
}

var scopedPermissionNames = map[string]func(*github.InstallationPermissions, *string){
	"actions":       func(p *github.InstallationPermissions, v *string) { p.Actions = v },
	"checks":        func(p *github.InstallationPermissions, v *string) { p.Checks = v },
	"contents":      func(p *github.InstallationPermissions, v *string) { p.Contents = v },
	"issues":        func(p *github.InstallationPermissions, v *string) { p.Issues = v },
	"metadata":      func(p *github.InstallationPermissions, v *string) { p.Metadata = v },
	"pull_requests": func(p *github.InstallationPermissions, v *string) { p.PullRequests = v },
	"workflows":     func(p *github.InstallationPermissions, v *string) { p.Workflows = v },
}

// Validate rejects an unscoped or over-broad request. A scoped token must name
// at least one repository and at least one explicit permission so it never
// inherits the installation's full grant.
func (s TokenScope) Validate() error {
	if len(s.Repositories) == 0 || len(s.Repositories) > 16 {
		return errors.New("scoped token requires between one and sixteen repositories")
	}
	for _, name := range s.Repositories {
		if name == "" || strings.ContainsAny(name, "/ \t\r\n") {
			return errors.New("scoped token repository name is invalid")
		}
	}
	if len(s.Permissions) == 0 {
		return errors.New("scoped token requires explicit permissions")
	}
	for name, level := range s.Permissions {
		if _, ok := scopedPermissionNames[name]; !ok {
			return fmt.Errorf("scoped token permission %q is not supported", name)
		}
		if level != "read" && level != "write" {
			return fmt.Errorf("scoped token permission %q has invalid level", name)
		}
	}
	return nil
}

// Key is a stable identity for pooling tokens with an identical grant.
func (s TokenScope) Key(installationID int64) string {
	repositories := slices.Clone(s.Repositories)
	for index := range repositories {
		repositories[index] = strings.ToLower(repositories[index])
	}
	slices.Sort(repositories)
	permissions := make([]string, 0, len(s.Permissions))
	for name, level := range s.Permissions {
		permissions = append(permissions, name+"="+level)
	}
	slices.Sort(permissions)
	return fmt.Sprintf("%d|%s|%s", installationID, strings.Join(repositories, ","), strings.Join(permissions, ","))
}

// MintScopedToken requests a fresh installation token restricted to scope.
// Unlike InstallationToken it never reuses a cached credential: every call
// creates a distinct token that the caller must revoke with RevokeToken.
// A nonempty token returned WITH an error is cleanup-only: the caller must
// retain and revoke it, never use it. This also covers rejected grants.
func (c *Client) MintScopedToken(ctx context.Context, installationID int64, scope TokenScope) (ScopedToken, error) {
	if installationID <= 0 {
		return ScopedToken{}, errors.New("installation id is required")
	}
	if err := scope.Validate(); err != nil {
		return ScopedToken{}, err
	}
	permissions := &github.InstallationPermissions{}
	for name, level := range scope.Permissions {
		value := level
		scopedPermissionNames[name](permissions, &value)
	}
	token, _, err := c.appClient.Apps.CreateInstallationToken(ctx, installationID, &github.InstallationTokenOptions{
		Repositories: slices.Clone(scope.Repositories),
		Permissions:  permissions,
	})
	if err != nil {
		return ScopedToken{}, fmt.Errorf("mint scoped installation token: %w", redactGitHubError(err))
	}
	if token.GetToken() == "" {
		return ScopedToken{}, errors.New("mint scoped installation token: response is missing a token")
	}
	minted := ScopedToken{value: token.GetToken(), InstallationID: installationID, ExpiresAt: token.GetExpiresAt().Time}
	cleanupDeadline := time.Now().Add(ScopedTokenLifetime)
	if minted.ExpiresAt.IsZero() || minted.ExpiresAt.After(cleanupDeadline) {
		// Installation tokens expire after one hour. Missing expiry evidence
		// cannot authorize use, but cleanup must retain a conservative lifetime.
		minted.ExpiresAt = cleanupDeadline
		return minted, errors.New("mint scoped installation token: response expiry is missing or invalid")
	}
	if err := verifyGrantedScope(scope, token); err != nil {
		return minted, fmt.Errorf("mint scoped installation token: %w", err)
	}
	appLog.Printf("minted scoped installation token repositories=%d permissions=%d", len(scope.Repositories), len(scope.Permissions))
	return ScopedToken{
		value:          token.GetToken(),
		InstallationID: installationID,
		ExpiresAt:      token.GetExpiresAt().Time,
		Repositories:   slices.Clone(scope.Repositories),
		Permissions:    clonePermissions(scope.Permissions),
	}, nil
}

// RevokeToken invalidates a scoped installation token immediately. A token that
// GitHub already treats as invalid is considered revoked.
func (c *Client) RevokeToken(ctx context.Context, token ScopedToken) error {
	if token.value == "" {
		return nil
	}
	client, err := c.tokenClient(token.value)
	if err != nil {
		return err
	}
	response, err := client.Apps.RevokeInstallationToken(ctx)
	if response != nil && response.Response != nil && response.StatusCode == http.StatusUnauthorized {
		return nil
	}
	if err != nil {
		return fmt.Errorf("revoke scoped installation token: %w", redactGitHubError(err))
	}
	appLog.Printf("revoked scoped installation token")
	return nil
}

// FindRepositoryInstallation resolves the installation covering repository
// using the App identity, independent of collection enrollment state.
func (c *Client) FindRepositoryInstallation(ctx context.Context, repository string) (int64, error) {
	owner, name, found := strings.Cut(strings.TrimSpace(repository), "/")
	if !found || owner == "" || name == "" || strings.Contains(name, "/") {
		return 0, fmt.Errorf("invalid repository reference %q", repository)
	}
	installation, response, err := c.appClient.Apps.FindRepositoryInstallation(ctx, owner, name)
	if response != nil && response.Response != nil && response.StatusCode == http.StatusNotFound {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("find repository installation: %w", redactGitHubError(err))
	}
	if installation.GetID() <= 0 {
		return 0, ErrNotFound
	}
	return installation.GetID(), nil
}

// CollaboratorPermission reads a user's effective base permission on repository
// using a scoped token that has at least metadata read access.
func (c *Client) CollaboratorPermission(ctx context.Context, token ScopedToken, repository, login string) (string, error) {
	owner, name, found := strings.Cut(strings.TrimSpace(repository), "/")
	if !found || owner == "" || name == "" || login == "" {
		return "", errors.New("repository and login are required")
	}
	client, err := c.tokenClient(token.value)
	if err != nil {
		return "", err
	}
	level, response, err := client.Repositories.GetPermissionLevel(ctx, owner, name, login)
	if response != nil && response.Response != nil && response.StatusCode == http.StatusNotFound {
		return "none", nil
	}
	if err != nil {
		return "", fmt.Errorf("read collaborator permission: %w", redactGitHubError(err))
	}
	// The base permission (admin, write, read, none) is stable across custom
	// repository roles, unlike role_name.
	return level.GetPermission(), nil
}

// BotIdentity is the Git author identity GitHub attributes to the App.
type BotIdentity struct {
	Name  string
	Email string
}

// BotIdentity resolves the App's bot user for Git commit attribution.
func (c *Client) BotIdentity(ctx context.Context) (BotIdentity, error) {
	c.identityMutex.Lock()
	defer c.identityMutex.Unlock()
	if c.identity != nil {
		return *c.identity, nil
	}
	app, _, err := c.appClient.Apps.Get(ctx, "")
	if err != nil {
		return BotIdentity{}, fmt.Errorf("read GitHub App identity: %w", redactGitHubError(err))
	}
	slug := app.GetSlug()
	if slug == "" {
		return BotIdentity{}, errors.New("GitHub App identity is missing a slug")
	}
	login := slug + "[bot]"
	// The public users endpoint does not require installation access.
	publicClient, err := enterpriseClient(&http.Client{Transport: c.baseTransport(), Timeout: c.config.RequestTimeout}, c.config)
	if err != nil {
		return BotIdentity{}, err
	}
	user, _, err := publicClient.Users.Get(ctx, login)
	if err != nil {
		return BotIdentity{}, fmt.Errorf("read GitHub App bot user: %w", redactGitHubError(err))
	}
	identity := BotIdentity{Name: login, Email: fmt.Sprintf("%d+%s@users.noreply.github.com", user.GetID(), login)}
	c.identity = &identity
	return identity, nil
}

func (c *Client) baseTransport() http.RoundTripper {
	if c.config.Transport != nil {
		return c.config.Transport
	}
	return http.DefaultTransport
}

func (c *Client) tokenClient(token string) (*github.Client, error) {
	if token == "" {
		return nil, errors.New("token is required")
	}
	httpClient := &http.Client{
		Transport: bearerTransport{token: token, base: c.baseTransport()},
		Timeout:   c.config.RequestTimeout,
	}
	return enterpriseClient(httpClient, c.config)
}

type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (t bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", "token "+t.token)
	return t.base.RoundTrip(clone)
}

// redactGitHubError drops response bodies that could echo request material
// while keeping status information useful for diagnosis.
func redactGitHubError(err error) error {
	var response *github.ErrorResponse
	if errors.As(err, &response) && response.Response != nil {
		return fmt.Errorf("GitHub API status %d", response.Response.StatusCode)
	}
	return err
}

func clonePermissions(permissions map[string]string) map[string]string {
	clone := make(map[string]string, len(permissions))
	for name, level := range permissions {
		clone[name] = level
	}
	return clone
}

var permissionRank = map[string]int{"read": 1, "write": 2}

// verifyGrantedScope fails closed unless GitHub granted exactly the requested
// repositories and no permission beyond the requested level.
func verifyGrantedScope(scope TokenScope, token *github.InstallationToken) error {
	granted := map[string]string{}
	if token.Permissions != nil {
		raw, err := json.Marshal(token.Permissions)
		if err != nil {
			return errors.New("granted permissions could not be read")
		}
		if err := json.Unmarshal(raw, &granted); err != nil {
			return errors.New("granted permissions could not be read")
		}
	}
	if len(granted) == 0 {
		return errors.New("response does not report granted permissions")
	}
	for name, level := range granted {
		requested, ok := scope.Permissions[name]
		if !ok || permissionRank[level] == 0 || permissionRank[level] > permissionRank[requested] {
			return fmt.Errorf("granted permission %q exceeds the requested scope", name)
		}
	}
	want := map[string]bool{}
	for _, name := range scope.Repositories {
		want[strings.ToLower(name)] = true
	}
	if len(token.Repositories) != len(want) {
		return errors.New("granted repositories differ from the requested scope")
	}
	for _, repository := range token.Repositories {
		if !want[strings.ToLower(repository.GetName())] {
			return errors.New("granted repositories differ from the requested scope")
		}
	}
	return nil
}
