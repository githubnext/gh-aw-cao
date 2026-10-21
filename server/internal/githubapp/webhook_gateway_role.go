package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// ValidateWebhookGatewayRole checks deployment-level separation of receiving
// and dispatch Apps. It does not replace current per-installation authorization.
func (c *Client) ValidateWebhookGatewayRole(ctx context.Context, role string) error {
	if c == nil || c.appClient == nil || c.config.AppID <= 0 || (role != "receive" && role != "dispatch") {
		return errors.New("GitHub gateway App role configuration is invalid")
	}
	// go-github v66 calls GET /app Apps.Get(ctx, ""). Decode its equivalent
	// response directly so newly introduced permission keys are not discarded
	// by the client's older InstallationPermissions struct.
	request, err := c.appClient.NewRequest(http.MethodGet, "app", nil)
	if err != nil {
		return errors.New("GitHub gateway App identity request unavailable")
	}
	client := c.appClient.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request.WithContext(ctx))
	if err != nil {
		return errors.New("GitHub gateway App identity unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return &GatewayAPIError{StatusCode: response.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil || len(data) > 64<<10 {
		return errors.New("GitHub gateway App identity response invalid")
	}
	var app struct {
		ID          int64             `json:"id"`
		Permissions map[string]string `json:"permissions"`
		Events      []string          `json:"events"`
	}
	if json.Unmarshal(data, &app) != nil || app.ID != c.config.AppID || app.Permissions == nil {
		return errors.New("GitHub gateway App identity mismatch")
	}
	for name, level := range app.Permissions {
		if level != "read" && level != "write" && level != "none" && level != "" {
			return errors.New("GitHub gateway App permission level invalid")
		}
		if role == "receive" && (name == "actions" || name == "contents") && level == "write" {
			return errors.New("GitHub gateway receiving App must not have dispatch permissions")
		}
		if role == "dispatch" && level != "" && level != "none" &&
			(strings.HasPrefix(name, "organization_") || name == "members" || name == "team_discussions" ||
				name == "blocking" || name == "emails" || name == "followers") {
			return errors.New("GitHub gateway dispatch App must have repository-only permissions")
		}
	}
	if role == "dispatch" && (app.Events == nil || len(app.Events) != 0) {
		return errors.New("GitHub gateway dispatch App must not subscribe to webhook events")
	}
	return nil
}
