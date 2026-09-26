package server

import (
	"context"
	"errors"
	"log"
	"net"
	"net/netip"
	"net/url"
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
	allowPrivatePlaintext, err := privatePlaintextRedisOptIn(os.Getenv("CAO_ALLOW_PRIVATE_PLAINTEXT_REDIS"))
	if err != nil {
		return nil, err
	}
	if err := validateHostedRedisURL(redisURL, allowPrivatePlaintext); err != nil {
		return nil, err
	}
	client, err := redisx.NewWithOptions(redisURL, redisx.Options{AllowPrivatePlaintext: allowPrivatePlaintext})
	if err != nil {
		return nil, err
	}
	store, err := storeFromClient(ctx, client)
	if err != nil {
		return nil, err
	}
	definitions, err := ParseDashboardQueries(dashboardQueriesPath)
	if err != nil {
		return nil, err
	}
	sourceDirectory := strings.TrimSpace(os.Getenv("CAO_SOURCE_DIRECTORY"))
	collector, err := CollectorConfigFromEnv()
	if err != nil {
		return nil, err
	}
	if collector == nil && sourceDirectory == "" {
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
	trustedProxyPrefixes, err := parseTrustedProxyPrefixes(os.Getenv("CAO_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return nil, err
	}
	trustForwarded := isLoopbackListen(listen) || len(trustedProxyPrefixes) > 0
	if trustForwarded {
		trustedProxyPrefixes = append(trustedProxyPrefixes, loopbackProxyPrefixes()...)
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
		Collector:           collector,
		WebhookSecret:       webhookSecret,
		AdminUsers:          adminUsers,
		Proxy: ProxyPolicy{
			AllowedHosts:         splitCSV(os.Getenv("CAO_ALLOWED_HOSTS")),
			RequireHTTPS:         true,
			TrustForwarded:       trustForwarded,
			TrustedProxyPrefixes: trustedProxyPrefixes,
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

func validateHostedRedisURL(redisURL string, allowPrivatePlaintext bool) error {
	parsed, err := url.Parse(strings.TrimSpace(redisURL))
	if err != nil {
		return errors.New("invalid hosted Redis URL")
	}
	if strings.EqualFold(parsed.Scheme, "rediss") {
		return nil
	}
	if !strings.EqualFold(parsed.Scheme, "redis") || !allowPrivatePlaintext {
		return errors.New("hosted mode requires rediss:// Redis transport unless private plaintext Redis is explicitly enabled")
	}
	if !privateRedisHostname(parsed.Hostname()) {
		return errors.New("hosted plaintext Redis requires a private IP or single-label service hostname")
	}
	return nil
}

func privatePlaintextRedisOptIn(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	default:
		return false, errors.New("CAO_ALLOW_PRIVATE_PLAINTEXT_REDIS must be true, false, or unset")
	}
}

func privateRedisHostname(hostname string) bool {
	if hostname == "" {
		return false
	}
	if ip := net.ParseIP(hostname); ip != nil {
		return ip.IsPrivate() || ip.IsLoopback()
	}
	return !strings.Contains(hostname, ".")
}

func parseTrustedProxyPrefixes(value string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, item := range splitCSV(value) {
		prefix, err := netip.ParsePrefix(item)
		if err != nil || !privateProxyPrefix(prefix) {
			return nil, errors.New("CAO_TRUSTED_PROXY_CIDRS must contain only private network CIDR prefixes")
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func privateProxyPrefix(prefix netip.Prefix) bool {
	for _, private := range []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("fc00::/7"),
		netip.MustParsePrefix("::1/128"),
	} {
		if prefix.Bits() >= private.Bits() && private.Contains(prefix.Addr().Unmap()) {
			return true
		}
	}
	return false
}

func loopbackProxyPrefixes() []netip.Prefix {
	return []netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
}

// StoreFromEnv opens the hosted Redis store described by the environment. The
// collection roles reuse it so there is one definition of the hosted Redis
// contract.
func StoreFromEnv(ctx context.Context) (*redisx.Store, error) {
	redisURL := strings.TrimSpace(os.Getenv("CAO_REDIS_URL"))
	if redisURL == "" {
		return nil, errors.New("CAO_REDIS_URL is required")
	}
	allowPrivatePlaintext, err := privatePlaintextRedisOptIn(os.Getenv("CAO_ALLOW_PRIVATE_PLAINTEXT_REDIS"))
	if err != nil {
		return nil, err
	}
	if err := validateHostedRedisURL(redisURL, allowPrivatePlaintext); err != nil {
		return nil, err
	}
	client, err := redisx.NewWithOptions(redisURL, redisx.Options{AllowPrivatePlaintext: allowPrivatePlaintext})
	if err != nil {
		return nil, err
	}
	return storeFromClient(ctx, client)
}

func storeFromClient(ctx context.Context, client *redisx.Client) (*redisx.Store, error) {
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
	return store, nil
}
