// Package githubapp wraps GitHub App authentication and the small set of
// App-level API calls the optional server ingestion profile needs.
//
// It is a thin layer over go-github and ghinstallation: token minting,
// caching, and transport belong to those libraries. What this package adds is
// the CAO-specific policy around them — enrollment enumeration, webhook
// delivery replay, and per-installation rate-limit governance that is shared
// across workers through Redis.
package githubapp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/bradleyfalzon/ghinstallation/v2"
	"github.com/google/go-github/v66/github"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var appLog = logger.New("cao:githubapp")

// Config describes the read-only GitHub App the collector authenticates as.
type Config struct {
	AppID          int64
	PrivateKeyPEM  []byte
	BaseURL        string
	UploadURL      string
	RequestTimeout time.Duration
}

// Validate reports whether the configuration can authenticate at all. It
// deliberately fails closed: a partially configured App is never treated as an
// unauthenticated client.
func (c Config) Validate() error {
	if c.AppID <= 0 {
		return errors.New("GitHub App id is required")
	}
	if len(c.PrivateKeyPEM) == 0 {
		return errors.New("GitHub App private key is required")
	}
	return nil
}

// Client authenticates as the App and mints installation clients on demand.
type Client struct {
	config        Config
	appTransport  *ghinstallation.AppsTransport
	appClient     *github.Client
	mutex         sync.Mutex
	installations map[int64]*installationEntry
}

type installationEntry struct {
	transport *ghinstallation.Transport
	client    *github.Client
}

// Installation is one App installation and the account it belongs to.
type Installation struct {
	ID      int64
	Account string
}

// Repository is one enrolled repository.
type Repository struct {
	FullName string
	PushedAt time.Time
}

// Delivery is one App webhook delivery, used for gap recovery.
type Delivery struct {
	ID             int64
	GUID           string
	Event          string
	StatusCode     int
	DeliveredAt    time.Time
	Redelivery     bool
	InstallationID int64
}

// New constructs a client for the configured App.
func New(config Config) (*Client, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 30 * time.Second
	}
	transport, err := ghinstallation.NewAppsTransport(http.DefaultTransport, config.AppID, config.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("configure GitHub App transport: %w", err)
	}
	if base := strings.TrimSpace(config.BaseURL); base != "" {
		transport.BaseURL = strings.TrimSuffix(base, "/")
	}
	httpClient := &http.Client{Transport: transport, Timeout: config.RequestTimeout}
	appClient, err := enterpriseClient(httpClient, config)
	if err != nil {
		return nil, err
	}
	return &Client{
		config:        config,
		appTransport:  transport,
		appClient:     appClient,
		installations: map[int64]*installationEntry{},
	}, nil
}

func enterpriseClient(httpClient *http.Client, config Config) (*github.Client, error) {
	client := github.NewClient(httpClient)
	base := strings.TrimSpace(config.BaseURL)
	if base == "" {
		return client, nil
	}
	upload := strings.TrimSpace(config.UploadURL)
	if upload == "" {
		upload = base
	}
	enterprise, err := client.WithEnterpriseURLs(base, upload)
	if err != nil {
		return nil, fmt.Errorf("configure GitHub base URL: %w", err)
	}
	return enterprise, nil
}

// ListInstallations enumerates every installation of the App. It is used for
// cold start and explicit repair, never as a routine discovery path.
func (c *Client) ListInstallations(ctx context.Context) ([]Installation, error) {
	options := &github.ListOptions{PerPage: 100}
	var installations []Installation
	for {
		page, response, err := c.appClient.Apps.ListInstallations(ctx, options)
		if err != nil {
			return nil, fmt.Errorf("list GitHub App installations: %w", err)
		}
		for _, installation := range page {
			if installation.GetID() == 0 {
				continue
			}
			installations = append(installations, Installation{
				ID:      installation.GetID(),
				Account: installation.GetAccount().GetLogin(),
			})
		}
		if response == nil || response.NextPage == 0 {
			break
		}
		options.Page = response.NextPage
	}
	appLog.Printf("enumerated installations count=%d", len(installations))
	return installations, nil
}

// ListRepositories enumerates the repositories one installation covers.
func (c *Client) ListRepositories(ctx context.Context, installationID int64) ([]Repository, error) {
	client, err := c.installationClient(installationID)
	if err != nil {
		return nil, err
	}
	options := &github.ListOptions{PerPage: 100}
	var repositories []Repository
	for {
		page, response, err := client.Apps.ListRepos(ctx, options)
		if err != nil {
			return nil, fmt.Errorf("list installation repositories: %w", err)
		}
		if page != nil {
			for _, repository := range page.Repositories {
				name := repository.GetFullName()
				if name == "" {
					continue
				}
				repositories = append(repositories, Repository{
					FullName: name,
					PushedAt: repository.GetPushedAt().Time,
				})
			}
		}
		if response == nil || response.NextPage == 0 {
			break
		}
		options.Page = response.NextPage
	}
	appLog.Printf("enumerated installation repositories count=%d", len(repositories))
	return repositories, nil
}

// InstallationToken mints a token for the collection subprocess. The token is
// never logged and never persisted.
func (c *Client) InstallationToken(ctx context.Context, installationID int64) (string, error) {
	entry, err := c.installation(installationID)
	if err != nil {
		return "", err
	}
	token, err := entry.transport.Token(ctx)
	if err != nil {
		return "", fmt.Errorf("mint installation token: %w", err)
	}
	return token, nil
}

// RateLimit reads the current core rate-limit state for an installation.
func (c *Client) RateLimit(ctx context.Context, installationID int64) (int, time.Time, error) {
	client, err := c.installationClient(installationID)
	if err != nil {
		return 0, time.Time{}, err
	}
	limits, _, err := client.RateLimit.Get(ctx)
	if err != nil {
		return 0, time.Time{}, fmt.Errorf("read installation rate limit: %w", err)
	}
	if limits == nil || limits.Core == nil {
		return 0, time.Time{}, errors.New("rate limit response is missing core limits")
	}
	return limits.Core.Remaining, limits.Core.Reset.Time, nil
}

// ListDeliveries reads App webhook deliveries newest first. Gap recovery walks
// this list back to the last processed delivery instead of sweeping
// repositories.
func (c *Client) ListDeliveries(ctx context.Context, cursor string, limit int) ([]Delivery, string, error) {
	if limit <= 0 {
		limit = 100
	}
	options := &github.ListCursorOptions{PerPage: 100, Cursor: cursor}
	var deliveries []Delivery
	next := cursor
	for len(deliveries) < limit {
		page, response, err := c.appClient.Apps.ListHookDeliveries(ctx, options)
		if err != nil {
			return nil, "", fmt.Errorf("list App webhook deliveries: %w", err)
		}
		for _, delivery := range page {
			deliveries = append(deliveries, Delivery{
				ID:             delivery.GetID(),
				GUID:           delivery.GetGUID(),
				Event:          delivery.GetEvent(),
				StatusCode:     delivery.GetStatusCode(),
				DeliveredAt:    delivery.GetDeliveredAt().Time,
				Redelivery:     delivery.GetRedelivery(),
				InstallationID: delivery.GetInstallationID(),
			})
		}
		if response == nil || response.Cursor == "" {
			next = ""
			break
		}
		next = response.Cursor
		options.Cursor = response.Cursor
	}
	return deliveries, next, nil
}

// Redeliver asks GitHub to send a delivery again. Redelivered events flow
// through the ordinary admission path, including deduplication.
func (c *Client) Redeliver(ctx context.Context, deliveryID int64) error {
	if _, _, err := c.appClient.Apps.RedeliverHookDelivery(ctx, deliveryID); err != nil {
		return fmt.Errorf("redeliver App webhook delivery: %w", err)
	}
	return nil
}

func (c *Client) installationClient(installationID int64) (*github.Client, error) {
	entry, err := c.installation(installationID)
	if err != nil {
		return nil, err
	}
	return entry.client, nil
}

func (c *Client) installation(installationID int64) (*installationEntry, error) {
	if installationID <= 0 {
		return nil, errors.New("installation id is required")
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if entry, ok := c.installations[installationID]; ok {
		return entry, nil
	}
	transport := ghinstallation.NewFromAppsTransport(c.appTransport, installationID)
	if base := strings.TrimSpace(c.config.BaseURL); base != "" {
		transport.BaseURL = strings.TrimSuffix(base, "/")
	}
	httpClient := &http.Client{Transport: transport, Timeout: c.config.RequestTimeout}
	client, err := enterpriseClient(httpClient, c.config)
	if err != nil {
		return nil, err
	}
	entry := &installationEntry{transport: transport, client: client}
	c.installations[installationID] = entry
	return entry, nil
}
