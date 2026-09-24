package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type HostingMode string

const (
	HostingModeLocal          HostingMode = "local"
	HostingModeAzureFunctions HostingMode = "azure-functions"
)

type AzureProxyPolicy struct {
	AllowedHosts []string
	RequireHTTPS bool
}

func validateAzureMode(store *redisx.Store, config *Config) error {
	if config.HostingMode != HostingModeAzureFunctions {
		return nil
	}
	if strings.TrimSpace(config.Listen) != "" || config.CertFile != "" || config.KeyFile != "" {
		return errors.New("azure Functions mode must not configure a listener or TLS files")
	}
	if strings.TrimSpace(config.AccessToken) != "" {
		return errors.New("azure Functions mode does not support local bearer capabilities")
	}
	if store == nil {
		return errors.New("azure Functions mode requires Redis")
	}
	if len(config.AzureProxy.AllowedHosts) == 0 {
		return errors.New("azure Functions mode requires an explicit trusted proxy host policy")
	}
	if config.GitHubOAuth == nil {
		return errors.New("azure Functions mode requires GitHub OAuth configuration")
	}
	if err := config.GitHubOAuth.validate(); err != nil {
		return err
	}
	return nil
}

func validAzureProxyRequest(request *http.Request, policy AzureProxyPolicy) bool {
	host := forwardedHeader(request, "X-Forwarded-Host")
	if host == "" {
		host = request.Host
	}
	host = strings.ToLower(strings.TrimSpace(strings.Split(host, ",")[0]))
	if host == "" {
		return false
	}
	if strings.Contains(host, ":") {
		host = strings.Split(host, ":")[0]
	}
	allowed := false
	for _, candidate := range policy.AllowedHosts {
		if strings.EqualFold(strings.TrimSpace(candidate), host) {
			allowed = true
			break
		}
	}
	if !allowed {
		return false
	}
	if !policy.RequireHTTPS {
		return true
	}
	proto := strings.ToLower(strings.TrimSpace(strings.Split(forwardedHeader(request, "X-Forwarded-Proto"), ",")[0]))
	return proto == "https"
}

func forwardedHeader(request *http.Request, name string) string {
	return strings.TrimSpace(request.Header.Get(name))
}

func NewAzureFunctionsHandlerFromEnv(ctx context.Context, siteDirectory, dashboardQueriesPath string, logger *log.Logger) (http.Handler, error) {
	redisURL := strings.TrimSpace(os.Getenv("CAO_REDIS_URL"))
	if redisURL == "" {
		return nil, errors.New("CAO_REDIS_URL is required")
	}
	if !strings.HasPrefix(strings.ToLower(redisURL), "rediss://") {
		return nil, errors.New("azure Functions mode requires rediss:// Redis transport")
	}
	client, err := redisx.New(redisURL)
	if err != nil {
		return nil, err
	}
	namespaceValue := strings.TrimSpace(os.Getenv("CAO_REDIS_NAMESPACE"))
	if namespaceValue == "" {
		namespaceValue = "azure-dashboard"
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
	app, err := New(store, Config{
		HostingMode:      HostingModeAzureFunctions,
		SiteDirectory:    siteDirectory,
		DashboardQueries: definitions,
		AzureProxy: AzureProxyPolicy{
			AllowedHosts: splitCSV(os.Getenv("CAO_AZURE_ALLOWED_HOSTS")),
			RequireHTTPS: strings.TrimSpace(os.Getenv("CAO_AZURE_REQUIRE_HTTPS")) != "false",
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
	})
	if err != nil {
		return nil, err
	}
	return app.AzureFunctionsHandler(), nil
}

func (a *App) AzureFunctionsHandler() http.Handler {
	return a.Handler()
}

func splitCSV(value string) []string {
	var output []string
	for _, item := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			output = append(output, trimmed)
		}
	}
	return output
}
