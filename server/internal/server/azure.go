package server

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

type HostingMode string

const (
	HostingModeLocal          HostingMode = "local"
	HostingModeHosted         HostingMode = "hosted"
	HostingModeAzureFunctions HostingMode = "azure-functions"
)

type ProxyPolicy struct {
	AllowedHosts   []string
	RequireHTTPS   bool
	TrustForwarded bool
}

type AzureProxyPolicy = ProxyPolicy

func validateHostedMode(store *redisx.Store, config *Config) error {
	if config.HostingMode != HostingModeAzureFunctions && config.HostingMode != HostingModeHosted {
		return nil
	}
	if config.HostingMode == HostingModeAzureFunctions &&
		(strings.TrimSpace(config.Listen) != "" || config.CertFile != "" || config.KeyFile != "") {
		return errors.New("azure Functions mode must not configure a listener or TLS files")
	}
	if config.HostingMode == HostingModeAzureFunctions {
		config.AzureProxy.TrustForwarded = true
	}
	if strings.TrimSpace(config.AccessToken) != "" {
		return errors.New("hosted mode does not support local bearer capabilities")
	}
	if store == nil {
		return errors.New("hosted mode requires Redis")
	}
	if len(config.Proxy.AllowedHosts) == 0 && len(config.AzureProxy.AllowedHosts) == 0 {
		return errors.New("hosted mode requires an explicit trusted proxy host policy")
	}
	policy := config.Proxy
	if config.HostingMode == HostingModeAzureFunctions {
		policy = config.AzureProxy
	}
	if !policy.RequireHTTPS && !config.AzureLocalSimulation {
		return errors.New("hosted mode requires HTTPS")
	}
	if config.HostingMode == HostingModeHosted {
		if err := validateHostedListen(config.Listen, config.CertFile, config.KeyFile); err != nil {
			return err
		}
		config.Proxy.TrustForwarded = isLoopbackListen(config.Listen)
	}
	if config.GitHubOAuth == nil {
		return errors.New("hosted mode requires GitHub OAuth configuration")
	}
	if err := config.GitHubOAuth.validate(); err != nil {
		return err
	}
	return nil
}

func validAzureProxyRequest(request *http.Request, policy AzureProxyPolicy) bool {
	host := request.Host
	secure := request.TLS != nil
	if policy.TrustForwarded {
		if forwarded := forwardedHeader(request, "X-Forwarded-Host"); forwarded != "" {
			host = forwarded
		}
		proto := strings.ToLower(strings.TrimSpace(strings.Split(forwardedHeader(request, "X-Forwarded-Proto"), ",")[0]))
		secure = proto == "https"
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
	return secure
}

func forwardedHeader(request *http.Request, name string) string {
	values := request.Header.Values(name)
	for valueIndex := len(values) - 1; valueIndex >= 0; valueIndex-- {
		parts := strings.Split(values[valueIndex], ",")
		for partIndex := len(parts) - 1; partIndex >= 0; partIndex-- {
			if value := strings.TrimSpace(parts[partIndex]); value != "" {
				return value
			}
		}
	}
	return ""
}

// processTelemetry lazily installs the OpenTelemetry tracer provider exactly
// once for the life of the process. The Azure Functions runtime reuses the
// process across invocations, so the exporter it configures must outlive any
// single request; bundling the sync.Once and its cached error into one type
// keeps that pairing in a single place instead of spreading a package-level
// mutex and error variable across the file.
type processTelemetry struct {
	once sync.Once
	err  error
}

// ensure configures telemetry on the first call and returns the cached
// outcome on every call thereafter. A configuration failure is logged at
// most once, on the call that performed the setup, and is treated as
// non-fatal: callers keep serving requests without exported traces rather
// than failing the whole handler over a bad exporter configuration.
func (p *processTelemetry) ensure(logger *log.Logger) error {
	p.once.Do(func() {
		p.err = configureProcessTelemetry()
		if p.err != nil && logger != nil {
			logger.Printf("telemetry configuration failed, continuing without exported traces: %v", p.err)
		}
	})
	return p.err
}

// configureProcessTelemetry installs the tracer provider with a process-
// lifetime context rather than a request-scoped one, since the resulting
// exporter is shared by every future invocation handled by this process.
func configureProcessTelemetry() error {
	version := strings.TrimSpace(os.Getenv("CAO_BUILD_VERSION"))
	if version == "" {
		version = "unknown"
	}
	_, err := telemetry.Setup(context.Background(), version)
	return err
}

var azureProcessTelemetry processTelemetry

func NewAzureFunctionsHandlerFromEnv(ctx context.Context, siteDirectory, dashboardQueriesPath string, logger *log.Logger) (http.Handler, error) {
	//nolint:contextcheck // configureProcessTelemetry intentionally uses context.Background(): the exporter it
	// configures must outlive the single request/invocation that happens to trigger processTelemetry.ensure.
	_ = azureProcessTelemetry.ensure(logger)
	redisURL := strings.TrimSpace(os.Getenv("CAO_REDIS_URL"))
	if redisURL == "" {
		return nil, errors.New("CAO_REDIS_URL is required")
	}
	localSimulation, err := azureLocalSimulationFromEnv()
	if err != nil {
		return nil, err
	}
	allowedHosts := splitCSV(os.Getenv("CAO_AZURE_ALLOWED_HOSTS"))
	redirectURL := os.Getenv("CAO_GITHUB_REDIRECT_URL")
	if err := validateAzureLocalEndpoints(localSimulation, allowedHosts, redirectURL); err != nil {
		return nil, err
	}
	if err := validateAzureRedisURL(redisURL, localSimulation); err != nil {
		return nil, err
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
	definitions, err := ParseDashboardQueries(dashboardQueriesPath)
	if err != nil {
		return nil, err
	}
	// The collection profile is optional. When it is unconfigured this reads
	// as nil and the Functions front end behaves exactly as before.
	collector, err := CollectorConfigFromEnv()
	if err != nil {
		return nil, err
	}
	app, err := New(store, Config{
		HostingMode:          HostingModeAzureFunctions,
		AzureLocalSimulation: localSimulation,
		SiteDirectory:        siteDirectory,
		DashboardQueries:     definitions,
		Collector:            collector,
		WebhookSecret:        os.Getenv("CAO_GITHUB_WEBHOOK_SECRET"),
		AdminUsers:           splitCSV(os.Getenv("CAO_GITHUB_ADMIN_USERS")),
		AzureProxy: AzureProxyPolicy{
			AllowedHosts:   allowedHosts,
			RequireHTTPS:   !localSimulation,
			TrustForwarded: true,
		},
		GitHubOAuth: &GitHubOAuthConfig{
			ClientID:              os.Getenv("CAO_GITHUB_CLIENT_ID"),
			ClientSecret:          os.Getenv("CAO_GITHUB_CLIENT_SECRET"),
			RedirectURL:           redirectURL,
			SessionSecret:         os.Getenv("CAO_SESSION_SECRET"),
			PreviousSessionSecret: os.Getenv("CAO_SESSION_SECRET_PREVIOUS"),
			AllowedOrganizations:  splitCSV(os.Getenv("CAO_GITHUB_ALLOWED_ORGS")),
			AllowedTeams:          splitCSV(os.Getenv("CAO_GITHUB_ALLOWED_TEAMS")),
		},
		Logger: logger,
	})
	if err != nil {
		return nil, err
	}
	go app.oauth.runRevocationWorker(context.WithoutCancel(ctx))
	return app.AzureFunctionsHandler(), nil
}

func azureLocalSimulationFromEnv() (bool, error) {
	switch value := strings.TrimSpace(os.Getenv("CAO_AZURE_LOCAL_SIMULATION")); value {
	case "":
		return false, nil
	case "1":
		return true, nil
	default:
		return false, errors.New("CAO_AZURE_LOCAL_SIMULATION must be 1 when enabled")
	}
}

func validateAzureRedisURL(redisURL string, localSimulation bool) error {
	parsed, err := url.Parse(redisURL)
	if err != nil {
		return errors.New("azure Functions mode requires a valid Redis URL")
	}
	if strings.EqualFold(parsed.Scheme, "rediss") {
		return nil
	}
	if !localSimulation || !strings.EqualFold(parsed.Scheme, "redis") {
		return errors.New("azure Functions mode requires rediss:// Redis transport")
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return nil
	}
	address := net.ParseIP(host)
	if address == nil || !address.IsLoopback() {
		return errors.New("local Azure simulation requires loopback Redis")
	}
	return nil
}

func validateAzureLocalEndpoints(localSimulation bool, allowedHosts []string, redirectURL string) error {
	if !localSimulation {
		return nil
	}
	for _, host := range allowedHosts {
		if !isLoopbackHost(host) {
			return errors.New("local Azure simulation requires loopback allowed hosts")
		}
	}
	parsed, err := url.Parse(strings.TrimSpace(redirectURL))
	if err != nil || !isLoopbackHost(parsed.Hostname()) {
		return errors.New("local Azure simulation requires a loopback OAuth redirect URL")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "localhost" {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
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
