package githubapp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v66/github"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (c *Client) WebhookGatewayConsumeLabel(ctx context.Context, s gateway.Subscription, target gateway.LabelRemoval,
	beforeWrite func() error, observe func(githubquota.ResponseQuota),
) error {
	if c == nil || beforeWrite == nil || observe == nil || gateway.ValidateSubscription(s, gateway.DefaultLimits()) != nil ||
		!gateway.RequiresLabelRemoval(s) || target.Number <= 0 || target.Label == "" ||
		!slices.Contains(s.Compiler.CommandFilter.Names, target.Label) ||
		!slices.Contains(s.Compiler.CommandFilter.Events, target.Event) ||
		!gateway.CompilerRepositoryMatches(*s.Compiler, target.Repository) {
		return gateway.ErrInvalid
	}
	client, _, err := c.webhookGatewayRepositoryClient(ctx, s.Source.InstallationID, s.Source.RepositoryID, observe)
	if err != nil {
		return gateway.ErrUnavailable
	}
	apiOrigin := strings.TrimSuffix(client.BaseURL.String(), "/")
	expected := s.Source.ServerURL + "/api/v3"
	if s.Source.ServerURL == "https://github.com" {
		expected = "https://api.github.com"
	}
	if apiOrigin != expected {
		return gateway.ErrUnauthorized
	}
	source, _, err := webhookGatewayRepositoryWithClient(ctx, client, s.Source.RepositoryID, observe)
	if err != nil || source.ID != s.Source.RepositoryID || !source.Private || source.Visibility != "private" ||
		source.Archived || source.Disabled || !strings.EqualFold(source.FullName, target.Repository) {
		return gateway.ErrUnauthorized
	}
	owner, repository, ok := strings.Cut(source.FullName, "/")
	if !ok || !gateway.CompilerOrganizationMatches(*s.Compiler, owner, source.OwnerID, source.OwnerType) ||
		s.Compiler.Orgs != nil && source.OwnerID != s.Source.OrganizationID {
		return gateway.ErrUnauthorized
	}
	kind := "issues"
	switch target.Event {
	case "pull_request":
		kind = "pull"
	case "discussion":
		kind = "discussions"
	case "issues":
	default:
		return gateway.ErrInvalid
	}
	if target.URL != s.Source.ServerURL+"/"+target.Repository+"/"+kind+"/"+strconv.FormatInt(target.Number, 10) {
		return gateway.ErrInvalid
	}
	if target.Event == "discussion" {
		return consumeDiscussionLabel(ctx, client, s, target, owner, repository, beforeWrite, observe)
	}
	if err := beforeWrite(); err != nil {
		return err
	}
	endpoint := "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repository) + "/issues/" +
		strconv.FormatInt(target.Number, 10) + "/labels/" + url.PathEscape(target.Label)
	_, err = gatewayLabelRequest(ctx, client, http.MethodDelete, endpoint, nil, false, observe)
	return err
}

func gatewayLabelRequest(ctx context.Context, client *github.Client, method, endpoint string, payload any,
	graph bool, observe func(githubquota.ResponseQuota),
) ([]byte, error) {
	request, err := client.NewRequest(method, endpoint, payload)
	if err != nil {
		return nil, gateway.ErrInvalid
	}
	request.Header.Set("X-GitHub-Api-Version", WebhookGatewayAPIVersion)
	httpClient := client.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := httpClient.Do(request.WithContext(ctx))
	if err != nil {
		return nil, gateway.ErrUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	quota := githubquota.ParseResponse(response.Header, response.StatusCode, time.Now())
	if graph && response.Header.Get("X-RateLimit-Resource") == "" {
		quota.Resource = "graphql"
	}
	observe(quota)
	body, err := io.ReadAll(io.LimitReader(response.Body, webhookGatewayResponseLimit+1))
	if err != nil || len(body) > webhookGatewayResponseLimit {
		return nil, gateway.ErrUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &GatewayAPIError{StatusCode: response.StatusCode}
	}
	return body, nil
}

func consumeDiscussionLabel(ctx context.Context, client *github.Client, s gateway.Subscription, target gateway.LabelRemoval,
	owner, repository string, beforeWrite func() error, observe func(githubquota.ResponseQuota),
) error {
	endpoint := *client.BaseURL
	if strings.HasSuffix(endpoint.Path, "/api/v3/") {
		endpoint.Path = strings.TrimSuffix(endpoint.Path, "/api/v3/") + "/api/graphql"
	} else {
		endpoint.Path = strings.TrimSuffix(endpoint.Path, "/") + "/graphql"
	}
	const query = `query($owner: String!, $repository: String!, $number: Int!, $label: String!) {
  repository(owner: $owner, name: $repository) {
    databaseId nameWithOwner isPrivate
    discussion(number: $number) { id number url }
    label(name: $label) { id name }
  }
}`
	body, err := gatewayLabelRequest(ctx, client, http.MethodPost, endpoint.String(), map[string]any{
		"query": query, "variables": map[string]any{"owner": owner, "repository": repository, "number": target.Number, "label": target.Label},
	}, true, observe)
	if err != nil {
		return err
	}
	var result struct {
		Data struct {
			Repository struct {
				ID      int64  `json:"databaseId"`
				Name    string `json:"nameWithOwner"`
				Private bool   `json:"isPrivate"`
				Item    struct {
					ID     string `json:"id"`
					Number int64  `json:"number"`
					URL    string `json:"url"`
				} `json:"discussion"`
				Label struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"label"`
			} `json:"repository"`
		} `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(body, &result) != nil || len(result.Errors) != 0 {
		return gateway.ErrUnavailable
	}
	source := result.Data.Repository
	if source.ID != s.Source.RepositoryID || !source.Private || !strings.EqualFold(source.Name, target.Repository) ||
		source.Item.ID == "" || source.Item.Number != target.Number || source.Item.URL != target.URL ||
		source.Label.ID == "" || source.Label.Name != target.Label {
		return gateway.ErrUnauthorized
	}
	if err := beforeWrite(); err != nil {
		return err
	}
	const mutation = `mutation($item: ID!, $labels: [ID!]!) {
  removeLabelsFromLabelable(input: {labelableId: $item, labelIds: $labels}) {
    labelable { id }
  }
}`
	body, err = gatewayLabelRequest(ctx, client, http.MethodPost, endpoint.String(), map[string]any{
		"query": mutation, "variables": map[string]any{"item": source.Item.ID, "labels": []string{source.Label.ID}},
	}, true, observe)
	if err != nil {
		return err
	}
	var removed struct {
		Data struct {
			Result struct {
				Item struct {
					ID string `json:"id"`
				} `json:"labelable"`
			} `json:"removeLabelsFromLabelable"`
		} `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(body, &removed) != nil || len(removed.Errors) != 0 || removed.Data.Result.Item.ID != source.Item.ID {
		return gateway.ErrUnavailable
	}
	return nil
}
