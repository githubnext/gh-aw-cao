package webhookgatewaylocal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type Repository struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Owner    struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"owner"`
}

type Client struct {
	base       string
	repository string
	token      string
	http       *http.Client
}

var locator = regexp.MustCompile(`^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$`)

// NewClient permits HTTPS GitHub API hosts, or numeric-loopback HTTP test
// servers. It never follows redirects or uses event-supplied URLs.
func NewClient(base, repository, token string) (*Client, error) {
	location, err := url.Parse(base)
	if err != nil || location.Host == "" || location.User != nil || location.RawQuery != "" || location.Fragment != "" ||
		!locator.MatchString(repository) || strings.ContainsAny(token, "\r\n") {
		return nil, wg.ErrInvalid
	}
	ip := net.ParseIP(location.Hostname())
	if location.Scheme != "https" && (location.Scheme != "http" || ip == nil || !ip.IsLoopback()) {
		return nil, wg.ErrInvalid
	}
	return &Client{base: strings.TrimRight(base, "/"), repository: repository, token: token,
		http: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}}, nil
}

func (c *Client) get(ctx context.Context, suffix, etag string, target any, limit int64) (http.Header, bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/repos/"+c.repository+suffix, nil)
	if err != nil {
		return nil, false, wg.ErrInvalid
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "cao-webhook-gateway-local")
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, errors.New("local GitHub polling request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotModified && etag != "" {
		return response.Header, true, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, false, errors.New("local GitHub polling requires a successful read response")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, false, errors.New("local GitHub polling response is unavailable or oversized")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if decoder.Decode(target) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, false, errors.New("local GitHub polling response is invalid")
	}
	return response.Header, false, nil
}

func (c *Client) Repository(ctx context.Context) (Repository, error) {
	var repository Repository
	_, _, err := c.get(ctx, "", "", &repository, 1<<20)
	if err != nil {
		return repository, err
	}
	if repository.ID < 1 || repository.Owner.ID < 1 || !strings.EqualFold(repository.FullName, c.repository) ||
		(repository.Owner.Type != "User" && repository.Owner.Type != "Organization") {
		return repository, errors.New("local GitHub repository identity could not be verified")
	}
	return repository, nil
}
