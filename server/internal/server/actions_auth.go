package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type githubPermissionProbe struct {
	name string
	path string
}

func verifyGitHubActionsPermissions(ctx context.Context, config Config, token string) error {
	repository := strings.TrimSpace(config.ActionsRepository)
	owner, name, ok := strings.Cut(repository, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return errors.New("GitHub Actions MCP authentication requires GITHUB_REPOSITORY in owner/repository form")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(config.GitHubAPIURL), "/")
	if baseURL == "" {
		baseURL = "https://api.github.com"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("GitHub Actions MCP API URL is invalid")
	}
	client := config.ActionsHTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	repositoryPath := "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	probes := []githubPermissionProbe{
		{name: "actions", path: repositoryPath + "/actions/runs?per_page=1"},
		{name: "contents", path: repositoryPath + "/contents?per_page=1"},
		{name: "issues", path: repositoryPath + "/issues?per_page=1"},
		{name: "pull-requests", path: repositoryPath + "/pulls?per_page=1"},
	}
	for _, probe := range probes {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+probe.path, nil)
		if err != nil {
			return errors.New("GitHub Actions MCP permission check could not be created")
		}
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		request.Header.Set("User-Agent", "gh-aw-cao-mcp")
		response, err := client.Do(request)
		if err != nil {
			return fmt.Errorf("GitHub Actions MCP %s permission check failed", probe.name)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			return fmt.Errorf("GitHub Actions token requires %s: read permission for MCP access", probe.name)
		}
	}
	return nil
}
