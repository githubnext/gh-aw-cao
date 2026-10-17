package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

const webhookGatewayProjectQuery = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on ProjectV2 {
      id
      owner {
        __typename
        ... on Organization { databaseId }
      }
    }
  }
}`

// WebhookGatewayProjects verifies current access to exactly the approved
// organization project nodes. It fetches no project content or item fields.
func (c *Client) WebhookGatewayProjects(ctx context.Context, installationID, organizationID int64, projectIDs []string) error {
	return c.WebhookGatewayProjectsWithQuota(ctx, installationID, organizationID, projectIDs, nil)
}

// WebhookGatewayProjectsWithQuota additionally exposes every GraphQL response
// for the host's shared installation quota accounting.
func (c *Client) WebhookGatewayProjectsWithQuota(
	ctx context.Context, installationID, organizationID int64, projectIDs []string,
	observe func(githubquota.ResponseQuota),
) error {
	if c == nil || installationID <= 0 || organizationID <= 0 || len(projectIDs) == 0 || len(projectIDs) > 100 {
		return errors.New("GitHub gateway project authority configuration is invalid")
	}
	seen := make(map[string]bool, len(projectIDs))
	for _, id := range projectIDs {
		if len(id) == 0 || len(id) > 256 || seen[id] {
			return errors.New("GitHub gateway project identity is invalid")
		}
		for _, char := range id {
			valid := char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' ||
				char == '_' || char == '-' || char == '+' || char == '/' || char == '='
			if !valid {
				return errors.New("GitHub gateway project identity is invalid")
			}
		}
		seen[id] = true
	}
	client, err := c.installationClient(installationID)
	if err != nil {
		return errors.New("GitHub gateway project installation unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	endpoint := *client.BaseURL
	if strings.HasSuffix(endpoint.Path, "/api/v3/") {
		endpoint.Path = strings.TrimSuffix(endpoint.Path, "/api/v3/") + "/api/graphql"
	} else {
		endpoint.Path = strings.TrimSuffix(endpoint.Path, "/") + "/graphql"
	}
	endpoint.RawPath, endpoint.RawQuery, endpoint.Fragment = "", "", ""
	httpClient := client.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, id := range projectIDs {
		request, err := client.NewRequest(http.MethodPost, endpoint.String(), struct {
			Query     string            `json:"query"`
			Variables map[string]string `json:"variables"`
		}{webhookGatewayProjectQuery, map[string]string{"id": id}})
		if err != nil {
			return errors.New("GitHub gateway project authority request invalid")
		}
		response, err := httpClient.Do(request.WithContext(ctx))
		if err != nil {
			quota := gatewayResponseQuota(nil, err)
			if observe != nil && quota.HasResponse {
				observe(quota)
			}
			return errors.New("GitHub gateway project authority unavailable")
		}
		quota := githubquota.ParseResponse(response.Header, response.StatusCode, time.Now().UTC())
		if response.Header.Get("X-RateLimit-Resource") == "" {
			quota.Resource = "graphql"
		}
		if observe != nil {
			observe(quota)
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, webhookGatewayResponseLimit+1))
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return &GatewayAPIError{StatusCode: response.StatusCode}
		}
		if readErr != nil || len(body) > webhookGatewayResponseLimit {
			return errors.New("GitHub gateway project authority response invalid")
		}
		var result struct {
			Data *struct {
				Node *struct {
					TypeName string `json:"__typename"`
					ID       string `json:"id"`
					Owner    *struct {
						TypeName   string `json:"__typename"`
						DatabaseID int64  `json:"databaseId"`
					} `json:"owner"`
				} `json:"node"`
			} `json:"data"`
			Errors []json.RawMessage `json:"errors"`
		}
		if json.Unmarshal(body, &result) != nil || len(result.Errors) != 0 ||
			result.Data == nil || result.Data.Node == nil || result.Data.Node.TypeName != "ProjectV2" ||
			result.Data.Node.ID != id || result.Data.Node.Owner == nil ||
			result.Data.Node.Owner.TypeName != "Organization" || result.Data.Node.Owner.DatabaseID != organizationID {
			return errors.New("GitHub gateway project authority not established")
		}
	}
	return nil
}
