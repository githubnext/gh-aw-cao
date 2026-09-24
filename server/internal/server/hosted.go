package server

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func NewHostedAppFromEnv(
	ctx context.Context,
	listen string,
	siteDirectory string,
	dashboardQueriesPath string,
	databaseQueriesPath string,
	logger *log.Logger,
) (*App, error) {
	redisURL := strings.TrimSpace(os.Getenv("CAO_REDIS_URL"))
	if redisURL == "" {
		return nil, errors.New("CAO_REDIS_URL is required")
	}
	client, err := redisx.New(redisURL)
	if err != nil {
		return nil, err
	}
	namespaceValue := strings.TrimSpace(os.Getenv("CAO_REDIS_NAMESPACE"))
	if namespaceValue == "" {
		namespaceValue = "hosted-dashboard"
	}
	namespace, err := redisx.NormalizeNamespace(namespaceValue)
	if err != nil {
		return nil, err
	}
	store := redisx.NewStore(client, namespace)
	if err := store.Ping(ctx); err != nil {
		return nil, errors.New("redis is unavailable")
	}
	if err := store.CheckRediSearch(ctx); err != nil {
		return nil, err
	}
	definitions, err := ParseDashboardQueries(dashboardQueriesPath)
	if err != nil {
		return nil, err
	}
	sourceDirectory := strings.TrimSpace(os.Getenv("CAO_SOURCE_DIRECTORY"))
	if sourceDirectory == "" {
		return nil, errors.New("CAO_SOURCE_DIRECTORY is required")
	}
	webhookSecret := os.Getenv("CAO_GITHUB_WEBHOOK_SECRET")
	if len(webhookSecret) < 32 {
		return nil, errors.New("CAO_GITHUB_WEBHOOK_SECRET must contain at least 32 characters")
	}
	config := Config{
		HostingMode:         HostingModeHosted,
		Listen:              listen,
		SiteDirectory:       siteDirectory,
		DashboardQueries:    definitions,
		DatabaseQueriesPath: databaseQueriesPath,
		SourceDirectory:     sourceDirectory,
		WebhookSecret:       webhookSecret,
		Proxy: ProxyPolicy{
			AllowedHosts: splitCSV(os.Getenv("CAO_ALLOWED_HOSTS")),
			RequireHTTPS: strings.TrimSpace(os.Getenv("CAO_REQUIRE_HTTPS")) != "false",
		},
		GitHubOAuth: &GitHubOAuthConfig{
			ClientID:             os.Getenv("CAO_GITHUB_CLIENT_ID"),
			ClientSecret:         os.Getenv("CAO_GITHUB_CLIENT_SECRET"),
			RedirectURL:          os.Getenv("CAO_GITHUB_REDIRECT_URL"),
			SessionSecret:        os.Getenv("CAO_SESSION_SECRET"),
			AllowedOrganizations: splitCSV(os.Getenv("CAO_GITHUB_ALLOWED_ORGS")),
			AllowedTeams:         splitCSV(os.Getenv("CAO_GITHUB_ALLOWED_TEAMS")),
		},
		Logger: logger,
	}
	return New(store, config)
}
