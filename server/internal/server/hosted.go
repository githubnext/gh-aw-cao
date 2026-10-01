package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var hostedLog = logger.New("cao:server:hosted")

func NewHostedAppFromEnv(
	ctx context.Context,
	listen string,
	certFile string,
	keyFile string,
	siteDirectory string,
	dashboardQueriesPath string,
	databaseQueriesPath string,
	mcpEnabled bool,
	agentCatalogPath string,
	mcpContractPath string,
	logger *log.Logger,
) (*App, error) {
	host, err := loadHostPolicyFromEnv()
	if err != nil {
		return nil, err
	}
	if host.Profile.Listener != HostListenerProcess {
		return nil, fmt.Errorf("host target module %q does not own a process listener", host.Profile.Name)
	}
	return newHostedAppWithPolicy(ctx, host, listen, certFile, keyFile, siteDirectory, dashboardQueriesPath, databaseQueriesPath, logger, mcpEnabled, agentCatalogPath, mcpContractPath)
}

// NewExternallyHostedAppFromEnv builds an OAuth-protected CAO service without
// opening a listener. The host policy must explicitly delegate listener
// ownership; credentials and transport policy remain CAO-owned.
func NewExternallyHostedAppFromEnv(
	ctx context.Context,
	siteDirectory, dashboardQueriesPath, databaseQueriesPath string,
	logger *log.Logger,
) (*App, error) {
	host, err := loadHostPolicyFromEnv()
	if err != nil {
		return nil, err
	}
	if host.Profile.Listener != HostListenerExternal {
		return nil, fmt.Errorf("host target module %q does not delegate listener ownership to an external host", host.Profile.Name)
	}
	return newHostedAppWithPolicy(ctx, host, "", "", "", siteDirectory, dashboardQueriesPath, databaseQueriesPath, logger, false, "", "")
}

func newHostedAppWithPolicy(
	ctx context.Context,
	host *resolvedHostPolicy,
	listen, certFile, keyFile, siteDirectory, dashboardQueriesPath, databaseQueriesPath string,
	logger *log.Logger,
	mcpEnabled bool,
	agentCatalogPath, mcpContractPath string,
) (*App, error) {
	if err := validateHostedRedisURL(
		host.RedisURL,
		host.RedisOptions.AllowPrivatePlaintext,
		host.RedisOptions.ForceTLS,
	); err != nil {
		return nil, err
	}
	revocationKeyPrefix, err := durableRevocationKeyPrefix(
		host.Profile.IsolateProcessNamespace,
		host.RedisNamespace,
	)
	if err != nil {
		return nil, err
	}
	client, err := redisx.NewWithOptions(host.RedisURL, host.RedisOptions)
	if err != nil {
		return nil, err
	}
	store, err := storeFromClient(
		ctx, client, host.RedisNamespace, host.Profile.IsolateProcessNamespace,
	)
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
	adminRepository := strings.TrimSpace(os.Getenv("CAO_COLLECT_CONTROL_REPOSITORY"))
	if len(adminUsers) == 0 && adminRepository == "" {
		return nil, errors.New("hosted administration requires CAO_GITHUB_ADMIN_USERS or CAO_COLLECT_CONTROL_REPOSITORY")
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
		HostProfile:            host.Profile,
		SingleReplicaConfirmed: host.SingleReplicaConfirmed,
		Listen:                 listen,
		CertFile:               certFile,
		KeyFile:                keyFile,
		SiteDirectory:          siteDirectory,
		DashboardQueries:       definitions,
		AgentCatalogPath:       agentCatalogPath,
		MCPContractPath:        mcpContractPath,
		MCPEnabled:             mcpEnabled,
		ActionsRepository:      strings.TrimSpace(os.Getenv("CAO_MCP_ACTIONS_REPOSITORY")),
		DatabaseQueriesPath:    databaseQueriesPath,
		SourceDirectory:        sourceDirectory,
		Collector:              collector,
		WebhookSecret:          webhookSecret,
		AdminUsers:             adminUsers,
		AdminRepository:        adminRepository,
		CORS:                   host.CORS,
		Proxy: ProxyPolicy{
			AllowedHosts:         splitCSV(os.Getenv("CAO_ALLOWED_HOSTS")),
			RequireHTTPS:         host.Profile.RequiresHTTPS,
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
			RevocationKeyPrefix:   revocationKeyPrefix,
		},
		Logger: logger,
	}
	return New(ctx, store, config)
}

// hostedRedisURLRejection classifies why validateHostedRedisURL rejected a
// hosted Redis URL. It is useful for diagnosing a misconfigured deployment
// without logging the URL itself, which can carry embedded credentials.
type hostedRedisURLRejection string

const (
	hostedRedisURLRejectionNone           hostedRedisURLRejection = "none"
	hostedRedisURLRejectionUnparsable     hostedRedisURLRejection = "unparsable"
	hostedRedisURLRejectionPlaintextOptIn hostedRedisURLRejection = "plaintext-not-opted-in"
	hostedRedisURLRejectionPublicHostname hostedRedisURLRejection = "public-hostname"
)

// classifyHostedRedisURL decides whether a hosted Redis URL is acceptable,
// given already-parsed scheme and hostname, without performing the URL
// parsing itself. It is a pure function extracted from validateHostedRedisURL
// so the TLS-required, opt-in, and private-hostname decisions are testable
// directly against scheme and hostname values, without constructing a
// *url.URL for every case.
func classifyHostedRedisURL(scheme, hostname string, allowPrivatePlaintext, forceTLS bool) hostedRedisURLRejection {
	if strings.EqualFold(scheme, "rediss") || forceTLS {
		return hostedRedisURLRejectionNone
	}
	if !strings.EqualFold(scheme, "redis") || !allowPrivatePlaintext {
		return hostedRedisURLRejectionPlaintextOptIn
	}
	if !privateRedisHostname(hostname) {
		return hostedRedisURLRejectionPublicHostname
	}
	return hostedRedisURLRejectionNone
}

func validateHostedRedisURL(redisURL string, allowPrivatePlaintext, forceTLS bool) error {
	parsed, err := url.Parse(strings.TrimSpace(redisURL))
	if err != nil {
		hostedLog.Printf("hosted redis url rejected reason=%s", hostedRedisURLRejectionUnparsable)
		return errors.New("invalid hosted Redis URL")
	}
	switch classifyHostedRedisURL(parsed.Scheme, parsed.Hostname(), allowPrivatePlaintext, forceTLS) {
	case hostedRedisURLRejectionPlaintextOptIn:
		hostedLog.Printf("hosted redis url rejected reason=%s", hostedRedisURLRejectionPlaintextOptIn)
		return errors.New("hosted mode requires rediss:// Redis transport unless private plaintext Redis is explicitly enabled")
	case hostedRedisURLRejectionPublicHostname:
		hostedLog.Printf("hosted redis url rejected reason=%s", hostedRedisURLRejectionPublicHostname)
		return errors.New("hosted plaintext Redis requires a private IP or single-label service hostname")
	default:
		return nil
	}
}

func isUpstashRedisURL(redisURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(redisURL))
	if err != nil {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	return hostname == "upstash.io" || strings.HasSuffix(hostname, ".upstash.io")
}

func privateRedisHostname(hostname string) bool {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	if hostname == "" {
		return false
	}
	if strings.HasSuffix(hostname, ".railway.internal") {
		return true
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
	host, err := loadHostPolicyFromEnv()
	if err != nil {
		return nil, err
	}
	if !host.Profile.SupportsCollection || host.Profile.RedisSession == HostRedisSerialized {
		return nil, fmt.Errorf(
			"host profile %q is not supported by standalone collection roles",
			host.Profile.Name,
		)
	}
	client, err := redisx.NewWithOptions(host.RedisURL, host.RedisOptions)
	if err != nil {
		return nil, err
	}
	return storeFromClient(ctx, client, host.RedisNamespace, false)
}

func storeFromClient(
	ctx context.Context,
	client *redisx.Client,
	namespaceValue string,
	isolateSession bool,
) (*redisx.Store, error) {
	namespaceValue = strings.TrimSpace(namespaceValue)
	if namespaceValue == "" {
		namespaceValue = "hosted-dashboard"
	}
	namespace, err := redisx.NormalizeNamespace(namespaceValue)
	if err != nil {
		return nil, err
	}
	var store *redisx.Store
	if isolateSession {
		store, err = redisx.NewProcessIsolatedStore(client, namespace)
		if err != nil {
			return nil, err
		}
	} else {
		store = redisx.NewStore(client, namespace)
	}
	if err := store.Ping(ctx); err != nil {
		return nil, errors.New("redis is unavailable")
	}
	return store, nil
}

func durableRevocationKeyPrefix(isolateProcess bool, namespace string) (string, error) {
	if !isolateProcess {
		return "", nil
	}
	if strings.TrimSpace(namespace) == "" {
		namespace = "hosted-dashboard"
	}
	normalized, err := redisx.NormalizeNamespace(namespace)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(normalized))
	// Preserve the original prefix so queued revocations survive migration from
	// the provider-specific Upstash mode to a generic serialized host profile.
	return "upstash-" + hex.EncodeToString(sum[:12]) + "-durable:", nil
}
