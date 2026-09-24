package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

var (
	setupTelemetryOnce sync.Once
	setupTelemetryErr  error
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

// setupProcessTelemetry installs the OpenTelemetry tracer provider once for
// the life of the process. It intentionally uses context.Background()
// instead of a request-scoped context: the Azure Functions runtime reuses
// the process across invocations, so the exporter this configures must
// outlive the single invocation that happens to trigger sync.Once.Do. Any
// setup failure is cached in setupTelemetryErr and logged here, once,
// because sync.Once never retries a failed first call; the failure is
// treated as non-fatal so a broken exporter configuration never prevents
// the dashboard from serving requests.
func setupProcessTelemetry(logger *log.Logger) {
	version := strings.TrimSpace(os.Getenv("CAO_BUILD_VERSION"))
	if version == "" {
		version = "unknown"
	}
	_, setupTelemetryErr = telemetry.Setup(context.Background(), version)
	if setupTelemetryErr != nil && logger != nil {
		logger.Printf("telemetry configuration failed, continuing without exported traces: %v", setupTelemetryErr)
	}
}

func NewAzureFunctionsHandlerFromEnv(ctx context.Context, siteDirectory, dashboardQueriesPath string, logger *log.Logger) (http.Handler, error) {
	//nolint:contextcheck // setupProcessTelemetry intentionally uses context.Background(): the exporter it
	// configures must outlive the single request/invocation that happens to trigger sync.Once.Do.
	setupTelemetryOnce.Do(func() { setupProcessTelemetry(logger) })
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
