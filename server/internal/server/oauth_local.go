package server

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func validateLocalDevelopmentOAuth(config Config) error {
	if config.GitHubOAuth == nil || config.GitHubOAuth.LocalDevelopmentUser == "" {
		return nil
	}
	if config.HostProfile.Authentication != HostAuthenticationOAuth ||
		config.HostProfile.Listener != HostListenerProcess || config.HostProfile.TrustsPlatformProxy ||
		!config.HostProfile.RequiresHTTPS || !config.Proxy.RequireHTTPS ||
		config.CertFile == "" || config.KeyFile == "" || !isLoopbackListen(config.Listen) {
		return errors.New("CAO_GITHUB_LOCAL_USER requires a process-owned loopback listener with direct TLS")
	}
	if config.Proxy.TrustForwarded || len(config.Proxy.TrustedProxyPrefixes) != 0 ||
		len(config.CORS.AllowedOrigins) != 0 {
		return errors.New("CAO_GITHUB_LOCAL_USER does not support proxies or cross-origin access")
	}
	host, port, err := net.SplitHostPort(config.Listen)
	if err != nil || port == "" || port == "0" {
		return errors.New("CAO_GITHUB_LOCAL_USER requires an explicit nonzero loopback listen port")
	}
	callback, err := url.Parse(config.GitHubOAuth.RedirectURL)
	if err != nil || callback.Scheme != "https" || callback.User != nil ||
		!strings.EqualFold(callback.Host, config.Listen) || callback.Path != "/auth/callback" ||
		callback.RawQuery != "" || callback.Fragment != "" {
		return errors.New("CAO_GITHUB_LOCAL_USER redirect must be https://<listen-address>/auth/callback")
	}
	if len(config.Proxy.AllowedHosts) != 1 || !strings.EqualFold(config.Proxy.AllowedHosts[0], host) {
		return errors.New("CAO_GITHUB_LOCAL_USER requires CAO_ALLOWED_HOSTS to match only the loopback listen host")
	}
	// The shared host classifier does not yet support bracketed IPv6 Host
	// headers. Avoid advertising a configuration it would then reject.
	if strings.Contains(host, ":") {
		return errors.New("CAO_GITHUB_LOCAL_USER requires localhost or an IPv4 loopback listen host")
	}
	return nil
}

func (oauth *githubOAuth) validLocalDevelopmentRequest(request *http.Request) bool {
	if oauth.config.LocalDevelopmentUser == "" {
		return true
	}
	callback, err := url.Parse(oauth.config.RedirectURL)
	return err == nil && request.TLS != nil &&
		strings.EqualFold(request.Host, callback.Host) &&
		trustedProxyPeer(request.RemoteAddr, loopbackProxyPrefixes())
}
