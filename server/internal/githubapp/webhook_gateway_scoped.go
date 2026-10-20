package githubapp

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/bradleyfalzon/ghinstallation/v2"
	githubv62 "github.com/google/go-github/v62/github"
	"github.com/google/go-github/v66/github"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
)

type gatewayMintTransport struct {
	base    http.RoundTripper
	observe func(githubquota.ResponseQuota)
	quota   githubquota.ResponseQuota
}

func (t *gatewayMintTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if response != nil && request.Method == http.MethodPost &&
		strings.Contains(request.URL.Path, "/app/installations/") && strings.HasSuffix(request.URL.Path, "/access_tokens") {
		t.quota = githubquota.ParseResponse(response.Header, response.StatusCode, time.Now().UTC())
		if t.observe != nil {
			t.observe(t.quota)
		}
		response.Body = struct {
			io.Reader
			io.Closer
		}{io.LimitReader(response.Body, 64<<10), response.Body}
	}
	return response, err
}

// A new transport forces a current repository-scoped mint for every authority
// check. Only this attempt reuses its token for the numeric lookup and dispatch.
func (c *Client) webhookGatewayRepositoryClient(
	ctx context.Context, installationID, repositoryID int64, observe func(githubquota.ResponseQuota),
) (*github.Client, githubquota.ResponseQuota, error) {
	if c == nil || installationID <= 0 || repositoryID <= 0 {
		return nil, githubquota.ResponseQuota{}, errors.New("GitHub gateway repository authority configuration is invalid")
	}
	base := c.config.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	mint := &gatewayMintTransport{base: base, observe: observe}
	// Do not share mutable AppsTransport refresh fields with another scoped
	// transport or the collector's cached installation clients.
	app, err := ghinstallation.NewAppsTransport(mint, c.config.AppID, c.config.PrivateKeyPEM)
	if err != nil {
		return nil, mint.quota, errors.New("GitHub gateway scoped authentication unavailable")
	}
	transport := ghinstallation.NewFromAppsTransport(app, installationID)
	if c.config.BaseURL != "" {
		transport.BaseURL = strings.TrimSuffix(c.config.BaseURL, "/")
	}
	transport.InstallationTokenOptions = &githubv62.InstallationTokenOptions{RepositoryIDs: []int64{repositoryID}}
	timeout := c.config.RequestTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	mintCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	token, err := transport.Token(mintCtx)
	if err != nil {
		var tokenErr *ghinstallation.HTTPError
		if errors.As(err, &tokenErr) && tokenErr.Response != nil {
			_ = tokenErr.Response.Body.Close()
			return nil, mint.quota, &GatewayAPIError{StatusCode: tokenErr.Response.StatusCode}
		}
		return nil, mint.quota, errors.New("GitHub gateway scoped repository access unavailable")
	}
	if token == "" {
		return nil, mint.quota, errors.New("GitHub gateway scoped repository token unavailable")
	}
	client, err := enterpriseClient(&http.Client{Transport: transport, Timeout: timeout}, c.config)
	if err != nil {
		return nil, mint.quota, errors.New("GitHub gateway scoped client unavailable")
	}
	return client, mint.quota, nil
}
