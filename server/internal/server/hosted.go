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
	certFile string,
	keyFile string,
	siteDirectory string,
	dashboardQueriesPath string,
	databaseQueriesPath string,
	logger *log.Logger,
) (*App, error) {
	redisURL := strings.TrimSpace(os.Getenv("CAO_REDIS_URL"))
	if redisURL == "" {
		return nil, errors.New("CAO_REDIS_URL is required")
	}
	if err := validateHostedRedisURL(redisURL); err != nil {
		return nil, err
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
	adminUsers := splitCSV(os.Getenv("CAO_GITHUB_ADMIN_USERS"))
	if len(adminUsers) == 0 {
		return nil, errors.New("CAO_GITHUB_ADMIN_USERS requires at least one GitHub login")
	}
	config := Config{
		HostingMode:         HostingModeHosted,
		Listen:              listen,
		CertFile:            certFile,
		KeyFile:             keyFile,
		SiteDirectory:       siteDirectory,
		DashboardQueries:    definitions,
		DatabaseQueriesPath: databaseQueriesPath,
		SourceDirectory:     sourceDirectory,
		WebhookSecret:       webhookSecret,
		AdminUsers:          adminUsers,
		Proxy: ProxyPolicy{
			AllowedHosts:   splitCSV(os.Getenv("CAO_ALLOWED_HOSTS")),
			RequireHTTPS:   true,
			TrustForwarded: isLoopbackListen(listen),
		},
		GitHubOAuth: &GitHubOAuthConfig{
			ClientID:              os.Getenv("CAO_GITHUB_CLIENT_ID"),
			ClientSecret:          os.Getenv("CAO_GITHUB_CLIENT_SECRET"),
			RedirectURL:           os.Getenv("CAO_GITHUB_REDIRECT_URL"),
			SessionSecret:         os.Getenv("CAO_SESSION_SECRET"),
			PreviousSessionSecret: os.Getenv("CAO_SESSION_SECRET_PREVIOUS"),
			AllowedOrganizations:  splitCSV(os.Getenv("CAO_GITHUB_ALLOWED_ORGS")),
			AllowedTeams:          splitCSV(os.Getenv("CAO_GITHUB_ALLOWED_TEAMS")),
		},
		Logger: logger,
	}
	return New(store, config)
}

func validateHostedRedisURL(redisURL string) error {
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(redisURL)), "rediss://") {
		return errors.New("hosted mode requires rediss:// Redis transport")
	}
	return nil
}
