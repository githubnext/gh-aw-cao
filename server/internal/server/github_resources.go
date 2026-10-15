package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

const (
	githubResourceFreshFor = 5 * time.Minute
	githubResourceKeepFor  = 24*time.Hour + githubResourceFreshFor
	githubResourceMaxBytes = 64 << 10
	githubUpstreamMaxBytes = 1 << 20
	githubResourceEntries  = 256
)

type githubRepositoryResource struct {
	FullName        string  `json:"full_name"`
	Description     *string `json:"description"`
	HTMLURL         string  `json:"html_url"`
	DefaultBranch   string  `json:"default_branch"`
	StargazersCount int64   `json:"stargazers_count"`
	ForksCount      int64   `json:"forks_count"`
	OpenIssuesCount int64   `json:"open_issues_count"`
	Archived        bool    `json:"archived"`
	Visibility      string  `json:"visibility"`
}

type githubReleaseResource struct {
	TagName     string  `json:"tag_name"`
	Name        *string `json:"name"`
	HTMLURL     string  `json:"html_url"`
	PublishedAt *string `json:"published_at"`
	Draft       bool    `json:"draft"`
	Prerelease  bool    `json:"prerelease"`
}

type githubResourceEntry struct {
	body         []byte
	etag         string
	upstreamETag string
	validated    time.Time
}

// This cache is disposable and process-scoped, not repository authority.
// Both its cardinality and each normalized payload are bounded.
type githubResourceCache struct {
	mu      sync.Mutex
	entries map[string]githubResourceEntry
	flight  singleflight.Group
	// These dependencies are overridden only by focused package tests.
	localToken func(context.Context) (string, error)
	transport  http.RoundTripper
}

func (c *githubResourceCache) get(key string) (githubResourceEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if ok && time.Since(entry.validated) > githubResourceKeepFor {
		delete(c.entries, key)
		return githubResourceEntry{}, false
	}
	return entry, ok
}

func (c *githubResourceCache) put(key string, entry githubResourceEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]githubResourceEntry)
	}
	if _, exists := c.entries[key]; !exists && len(c.entries) >= githubResourceEntries {
		var oldestKey string
		var oldest time.Time
		for candidate, value := range c.entries {
			if oldestKey == "" || value.validated.Before(oldest) {
				oldestKey, oldest = candidate, value.validated
			}
		}
		delete(c.entries, oldestKey)
	}
	c.entries[key] = entry
}

type githubResourceError struct {
	status int
	retry  time.Time
}

type githubResourceCredentials struct {
	token  string
	base   string
	app    string
	client *http.Client
}

func (e *githubResourceError) Error() string { return "GitHub resource is unavailable" }

func (a *App) gitHubRepositoryResource(w http.ResponseWriter, r *http.Request) {
	a.gitHubResource(w, r, false)
}

func (a *App) gitHubReleaseResource(w http.ResponseWriter, r *http.Request) {
	a.gitHubResource(w, r, true)
}

//nolint:contextcheck // Shared bounded revalidation must survive cancellation of its first subscriber.
func (a *App) gitHubResource(w http.ResponseWriter, r *http.Request, release bool) {
	w.Header().Add("Vary", "Authorization")
	w.Header().Add("Vary", "Cookie")
	repository, err := collect.NormalizeRepository(r.PathValue("owner") + "/" + r.PathValue("repo"))
	if err != nil || len(repository) > 256 || r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "invalid GitHub resource request")
		return
	}
	installation, err := a.githubResourceScope(r.Context(), repository)
	if err != nil {
		writeGitHubResourceError(w, err)
		return
	}
	credentialCtx, cancelCredentials := context.WithTimeout(r.Context(), 15*time.Second)
	credentials, err := a.githubResourceCredentials(credentialCtx, installation)
	cancelCredentials()
	if err != nil {
		writeGitHubResourceError(w, err)
		return
	}
	path := "repos/" + repository
	if release {
		path += "/releases/latest"
	}
	key := githubResourceKey(installation, path, r.Header, credentials.token)
	entry, ok := a.githubResources.get(key)
	stale := false
	if !ok || time.Since(entry.validated) >= githubResourceFreshFor {
		result := a.githubResources.flight.DoChan(key, func() (any, error) {
			if cached, found := a.githubResources.get(key); found && time.Since(cached.validated) < githubResourceFreshFor {
				return cached, nil
			}
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 20*time.Second)
			defer cancel()
			return a.fetchGitHubResource(ctx, credentials, installation, path, key, release)
		})
		select {
		case <-r.Context().Done():
			return
		case fetched := <-result:
			if fetched.Err != nil {
				if !ok || !githubResourceTransientError(fetched.Err) {
					writeGitHubResourceError(w, fetched.Err)
					return
				}
				stale = true
			} else {
				entry = fetched.Val.(githubResourceEntry)
			}
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=300, stale-while-revalidate=86400")
	w.Header().Set("Age", strconv.Itoa(max(0, int(time.Since(entry.validated).Seconds()))))
	w.Header().Set("ETag", entry.etag)
	if stale {
		w.Header().Set("Cache-Control", "private, max-age=0, stale-while-revalidate=86400")
		w.Header().Set("Warning", `110 - "Response is stale"`)
	}
	if !stale && githubETagMatches(r.Header.Get("If-None-Match"), entry.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(entry.body)
}

func githubResourceKey(installation int64, path string, headers http.Header, credential string) string {
	identity := sha256.Sum256([]byte(headers.Get("Authorization") + "\x00" + headers.Get("Cookie") + "\x00" + credential))
	return strconv.FormatInt(installation, 10) + ":" + path + ":" + hex.EncodeToString(identity[:])
}

func (a *App) githubResourceScope(ctx context.Context, repository string) (int64, error) {
	if a.config.HostProfile.Name == "local" && a.config.HostProfile.Authentication == HostAuthenticationBearer {
		if strings.EqualFold(repository, a.config.ActionsRepository) ||
			(a.config.Collector != nil && strings.EqualFold(repository, a.config.Collector.ControlRepository)) {
			return 1, nil
		}
		return 0, &githubResourceError{status: http.StatusForbidden}
	}
	collector := a.Collector()
	if collector == nil || collector.client == nil || a.config.Collector == nil || a.config.Collector.AdmitOnly {
		return 0, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	installation, err := collector.enrollment.InstallationFor(ctx, repository)
	if err != nil {
		return 0, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	if installation <= 0 {
		return 0, &githubResourceError{status: http.StatusForbidden}
	}
	return installation, nil
}

func localGitHubResourceToken(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "gh", "auth", "token", "--hostname", "github.com")
	output, err := command.Output()
	if err != nil || strings.TrimSpace(string(output)) == "" {
		return "", &githubResourceError{status: http.StatusServiceUnavailable}
	}
	return strings.TrimSpace(string(output)), nil
}

func (a *App) githubResourceCredentials(ctx context.Context, installation int64) (githubResourceCredentials, error) {
	base, app := "https://api.github.com", "local-cli"
	transport := http.DefaultTransport
	var token string
	var err error
	if a.config.HostProfile.Name == "local" && a.config.HostProfile.Authentication == HostAuthenticationBearer {
		resolve := a.githubResources.localToken
		if resolve == nil {
			resolve = localGitHubResourceToken
		}
		token, err = resolve(ctx)
	} else {
		collector := a.Collector()
		if collector == nil || collector.client == nil || a.config.Collector == nil {
			return githubResourceCredentials{}, &githubResourceError{status: http.StatusServiceUnavailable}
		}
		token, err = collector.client.InstallationToken(ctx, installation)
		app = "github-app-" + strconv.FormatInt(a.config.Collector.AppID, 10)
		if a.config.Collector.BaseURL != "" {
			base = strings.TrimSuffix(a.config.Collector.BaseURL, "/")
		}
		if a.config.Collector.Transport != nil {
			transport = a.config.Collector.Transport
		}
	}
	if err != nil || strings.TrimSpace(token) == "" {
		return githubResourceCredentials{}, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	if a.githubResources.transport != nil {
		transport = a.githubResources.transport
	}
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return githubResourceCredentials{token: token, base: base, app: app, client: client}, nil
}

func githubResourceRequest(ctx context.Context, client *http.Client, base, token, path, etag string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/"+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	return client.Do(request)
}

func (a *App) reserveGitHubResource(ctx context.Context, client *http.Client, token, base string, bucket githubquota.BucketID) (githubquota.Reservation, error) {
	if a.quota == nil {
		return githubquota.Reservation{}, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	reservation, err := a.quota.Reserve(ctx, bucket, githubquota.ReservationRequest{EstimatedCost: 1})
	if !errors.Is(err, githubquota.ErrUnknown) {
		return reservation, err
	}
	// Serialize cold-bucket probes as well as resource reads.
	_, err, _ = a.githubResources.flight.Do("quota:"+bucket.String(), func() (any, error) {
		state, stateErr := a.quota.State(ctx, bucket)
		if stateErr != nil || state.Status != githubquota.StatusUnknown {
			return nil, stateErr
		}
		response, requestErr := githubResourceRequest(ctx, client, base, token, "rate_limit", "")
		if requestErr != nil {
			return nil, requestErr
		}
		defer func() { _ = response.Body.Close() }()
		quota, recordErr := a.quota.RecordResponse(ctx, bucket.App, bucket.Installation, response.Header, response.StatusCode)
		if recordErr != nil {
			return nil, recordErr
		}
		if limited := githubResourceRateLimit(response.StatusCode, quota); limited != nil {
			return nil, limited
		}
		if response.StatusCode != http.StatusOK || !quota.HasObservation {
			return nil, &githubResourceError{status: http.StatusServiceUnavailable}
		}
		return nil, nil
	})
	if err != nil {
		return githubquota.Reservation{}, err
	}
	return a.quota.Reserve(ctx, bucket, githubquota.ReservationRequest{EstimatedCost: 1})
}

func (a *App) fetchGitHubResource(ctx context.Context, credentials githubResourceCredentials, installation int64, path, key string, release bool) (githubResourceEntry, error) {
	token, base, app, client := credentials.token, credentials.base, credentials.app, credentials.client
	bucket := githubquota.BucketID{App: app, Installation: installation, Resource: githubquota.ResourceCore}
	reservation, err := a.reserveGitHubResource(ctx, client, token, base, bucket)
	if err != nil {
		return githubResourceEntry{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = a.quota.Release(cleanup, reservation)
	}()
	cached, exists := a.githubResources.get(key)
	response, err := githubResourceRequest(ctx, client, base, token, path, cached.upstreamETag)
	if err != nil {
		return githubResourceEntry{}, err
	}
	defer func() { _ = response.Body.Close() }()
	quota, err := a.quota.RecordResponse(ctx, app, installation, response.Header, response.StatusCode)
	if err != nil {
		return githubResourceEntry{}, err
	}
	if limited := githubResourceRateLimit(response.StatusCode, quota); limited != nil {
		return githubResourceEntry{}, limited
	}
	if response.StatusCode == http.StatusNotFound {
		return githubResourceEntry{}, &githubResourceError{status: http.StatusNotFound}
	}
	if response.StatusCode == http.StatusNotModified && exists {
		cached.validated = time.Now()
		if etag := response.Header.Get("ETag"); etag != "" {
			cached.upstreamETag = etag
		}
		a.githubResources.put(key, cached)
		return cached, nil
	}
	if response.StatusCode != http.StatusOK {
		return githubResourceEntry{}, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, githubUpstreamMaxBytes+1))
	if err != nil || len(body) > githubUpstreamMaxBytes {
		return githubResourceEntry{}, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	normalized, err := normalizeGitHubResource(body, release)
	if err != nil || len(normalized) > githubResourceMaxBytes {
		if err == nil {
			err = &githubResourceError{status: http.StatusServiceUnavailable}
		}
		return githubResourceEntry{}, err
	}
	sum := sha256.Sum256(normalized)
	entry := githubResourceEntry{body: normalized, etag: `"` + hex.EncodeToString(sum[:]) + `"`,
		upstreamETag: response.Header.Get("ETag"), validated: time.Now()}
	a.githubResources.put(key, entry)
	return entry, nil
}

func normalizeGitHubResource(body []byte, release bool) ([]byte, error) {
	if release {
		var value githubReleaseResource
		if err := json.Unmarshal(body, &value); err != nil || value.TagName == "" || value.HTMLURL == "" {
			return nil, &githubResourceError{status: http.StatusServiceUnavailable}
		}
		return json.Marshal(value)
	}
	var value githubRepositoryResource
	if err := json.Unmarshal(body, &value); err != nil || value.FullName == "" || value.HTMLURL == "" {
		return nil, &githubResourceError{status: http.StatusServiceUnavailable}
	}
	return json.Marshal(value)
}

func githubETagMatches(header, etag string) bool {
	for candidate := range strings.SplitSeq(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

func githubResourceRateLimit(status int, quota githubquota.ResponseQuota) error {
	if status != http.StatusTooManyRequests &&
		(status != http.StatusForbidden || (quota.ParkUntil.IsZero() && (!quota.HasObservation || quota.Observation.Remaining > 0))) {
		return nil
	}
	retry := quota.ParkUntil
	if retry.IsZero() && quota.HasObservation {
		retry = quota.Observation.ResetAt
	}
	return &githubResourceError{status: http.StatusTooManyRequests, retry: retry}
}

func githubResourceTransientError(err error) bool {
	var resourceError *githubResourceError
	if errors.As(err, &resourceError) {
		return resourceError.status == http.StatusServiceUnavailable
	}
	var quotaError *githubquota.UnavailableError
	return !errors.As(err, &quotaError)
}

func writeGitHubResourceError(w http.ResponseWriter, err error) {
	status := http.StatusServiceUnavailable
	retry := time.Now().Add(time.Minute)
	var resourceError *githubResourceError
	var unavailable *githubquota.UnavailableError
	switch {
	case errors.As(err, &resourceError):
		status = resourceError.status
		if !resourceError.retry.IsZero() {
			retry = resourceError.retry
		}
	case errors.As(err, &unavailable):
		if unavailable.Status == githubquota.StatusExhausted || unavailable.Status == githubquota.StatusParked {
			status = http.StatusTooManyRequests
			if !unavailable.RetryAt.IsZero() {
				retry = unavailable.RetryAt
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
		seconds := max(1, int(time.Until(retry).Seconds()+1))
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}
	writeError(w, status, "GitHub resource is unavailable")
}
