package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bradleyfalzon/ghinstallation/v2"
	"github.com/google/go-github/v66/github"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	"github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

const webhookGatewayResponseLimit = 16 << 10

// WebhookGatewayAPIVersion pins the dispatch API contract independently of the
// older go-github client's default; callers also tolerate legacy HTTP 204.
const WebhookGatewayAPIVersion = "2026-03-10"

// GatewayInstallation describes current authority, never credentials.
type GatewayInstallation struct {
	ID, AppID, AccountID int64
	AccountLogin         string
	AccountType          string
	Suspended            bool
	Permissions          map[string]string
}

// GatewayRepository is resolved with installation authentication by immutable ID.
type GatewayRepository struct {
	ID, OwnerID                 int64
	FullName, Visibility        string
	DefaultBranch, OwnerType    string
	Private, Archived, Disabled bool
	Permissions                 map[string]bool
}

// GatewayAPIError deliberately excludes GitHub's potentially sensitive error text.
// In particular, a 404 cannot distinguish removal from inaccessible authority.
type GatewayAPIError struct {
	StatusCode int
}

func (c *Client) WebhookGatewayServerURL() string {
	if c == nil {
		return ""
	}
	if c.config.BaseURL == "" || strings.TrimSuffix(c.config.BaseURL, "/") == "https://api.github.com" {
		return "https://github.com"
	}
	base, err := url.Parse(c.config.BaseURL)
	if err != nil || base.Scheme != "https" || base.User != nil || base.Host == "" ||
		base.RawQuery != "" || base.ForceQuery || base.Fragment != "" || base.RawPath != "" {
		return ""
	}
	base.Path = strings.TrimSuffix(strings.TrimSuffix(base.Path, "/"), "/api/v3")
	return base.String()
}

func (e *GatewayAPIError) Error() string {
	return fmt.Sprintf("GitHub gateway authority unavailable (HTTP %d)", e.StatusCode)
}

// WebhookGatewayInstallation reads current installation identity and permissions.
func (c *Client) WebhookGatewayInstallation(ctx context.Context, id int64) (GatewayInstallation, githubquota.ResponseQuota, error) {
	if c == nil || c.appClient == nil || id <= 0 {
		return GatewayInstallation{}, githubquota.ResponseQuota{}, errors.New("GitHub gateway installation configuration is invalid")
	}
	installation, response, err := c.appClient.Apps.GetInstallation(ctx, id)
	quota := gatewayResponseQuota(response, err)
	if err != nil {
		return GatewayInstallation{}, quota, &GatewayAPIError{StatusCode: apiResponse(response, err).StatusCode}
	}
	if installation == nil || installation.GetID() != id || installation.GetAppID() != c.config.AppID ||
		installation.GetAccount().GetID() <= 0 ||
		(installation.GetAccount().GetType() != "Organization" && installation.GetAccount().GetType() != "User") {
		return GatewayInstallation{}, quota, errors.New("GitHub gateway installation identity mismatch")
	}
	permissions := map[string]string{}
	encoded, err := json.Marshal(installation.Permissions)
	if err != nil {
		return GatewayInstallation{}, quota, errors.New("GitHub gateway installation permissions unavailable")
	}
	if err := json.Unmarshal(encoded, &permissions); err != nil {
		return GatewayInstallation{}, quota, errors.New("GitHub gateway installation permissions invalid")
	}
	return GatewayInstallation{
		ID: id, AppID: installation.GetAppID(), AccountID: installation.GetAccount().GetID(),
		AccountLogin: installation.GetAccount().GetLogin(), AccountType: installation.GetAccount().GetType(),
		Suspended:   installation.SuspendedAt != nil && !installation.SuspendedAt.IsZero(),
		Permissions: permissions,
	}, quota, nil
}

// WebhookGatewayRepository checks installation access using the numeric route.
func (c *Client) WebhookGatewayRepository(ctx context.Context, installationID, repositoryID int64, observers ...func(githubquota.ResponseQuota)) (GatewayRepository, githubquota.ResponseQuota, error) {
	if c == nil || repositoryID <= 0 {
		return GatewayRepository{}, githubquota.ResponseQuota{}, errors.New("GitHub gateway repository configuration is invalid")
	}
	observe := func(quota githubquota.ResponseQuota) {
		for _, observer := range observers {
			if observer != nil {
				observer(quota)
			}
		}
	}
	client, quota, err := c.webhookGatewayRepositoryClient(ctx, installationID, repositoryID, observe)
	if err != nil {
		return GatewayRepository{}, quota, err
	}
	return webhookGatewayRepositoryWithClient(ctx, client, repositoryID, observe)
}

func webhookGatewayRepositoryWithClient(ctx context.Context, client *github.Client, repositoryID int64, observe func(githubquota.ResponseQuota)) (GatewayRepository, githubquota.ResponseQuota, error) {
	repository, response, err := client.Repositories.GetByID(ctx, repositoryID)
	quota := gatewayResponseQuota(response, err)
	observe(quota)
	if err != nil {
		return GatewayRepository{}, quota, &GatewayAPIError{StatusCode: apiResponse(response, err).StatusCode}
	}
	if repository == nil || repository.GetID() != repositoryID || repository.GetOwner().GetID() <= 0 {
		return GatewayRepository{}, quota, errors.New("GitHub gateway repository identity mismatch")
	}
	visibility := repository.GetVisibility()
	if visibility == "" {
		if repository.Private == nil {
			return GatewayRepository{}, quota, errors.New("GitHub gateway repository visibility unavailable")
		}
		if repository.GetPrivate() {
			visibility = "private"
		} else {
			visibility = "public"
		}
	}
	if visibility != "public" && visibility != "private" && visibility != "internal" {
		return GatewayRepository{}, quota, errors.New("GitHub gateway repository visibility invalid")
	}
	return GatewayRepository{
		ID: repository.GetID(), OwnerID: repository.GetOwner().GetID(), FullName: repository.GetFullName(),
		Visibility: visibility, Private: repository.GetPrivate(), Archived: repository.GetArchived(),
		Disabled: repository.GetDisabled(), Permissions: repository.Permissions,
		DefaultBranch: repository.GetDefaultBranch(), OwnerType: repository.GetOwner().GetType(),
	}, quota, nil
}

// WebhookGatewayDispatcher must be constructed with the dispatch App's client,
// independently of the receiving process and its credentials.
type WebhookGatewayDispatcher struct {
	Client                *Client
	Receiving             *Client
	ObserveQuota          func(context.Context, int64, githubquota.ResponseQuota) error
	ObserveReceivingQuota func(context.Context, int64, githubquota.ResponseQuota) error
}

func (d WebhookGatewayDispatcher) Dispatch(ctx context.Context, subscription webhookgateway.Subscription, payload json.RawMessage) webhookgateway.DispatchResponse {
	result, _ := d.DispatchWithQuota(ctx, subscription, payload)
	return result
}

// DispatchWithQuota sends only the complete envelope produced by BuildDispatchBatch.
// Compiler routes recheck the current default head and whole-lock digest.
// This adapter never retries a POST.
// Quota observation failures cannot overwrite a known dispatch outcome.
func (d WebhookGatewayDispatcher) DispatchWithQuota(ctx context.Context, subscription webhookgateway.Subscription, payload json.RawMessage) (webhookgateway.DispatchResponse, githubquota.ResponseQuota) {
	return d.dispatchWithQuota(ctx, subscription, payload, nil)
}

func (d WebhookGatewayDispatcher) DispatchCompiler(ctx context.Context, subscription webhookgateway.Subscription, payload json.RawMessage, revision webhookgateway.Revision) webhookgateway.DispatchResponse {
	result, _ := d.DispatchCompilerWithQuota(ctx, subscription, payload, revision)
	return result
}

func (d WebhookGatewayDispatcher) DispatchCompilerWithQuota(ctx context.Context, subscription webhookgateway.Subscription, payload json.RawMessage, revision webhookgateway.Revision) (webhookgateway.DispatchResponse, githubquota.ResponseQuota) {
	return d.dispatchWithQuota(ctx, subscription, payload, &revision)
}

func (d WebhookGatewayDispatcher) dispatchWithQuota(ctx context.Context, subscription webhookgateway.Subscription, payload json.RawMessage, revision *webhookgateway.Revision) (webhookgateway.DispatchResponse, githubquota.ResponseQuota) {
	destination := subscription.Destination
	result := webhookgateway.DispatchResponse{Kind: destination.Kind, TransportOutcome: "not-sent"}
	if d.Client == nil || d.Client.config.AppID <= 0 || subscription.AppID != d.Client.config.AppID ||
		webhookgateway.ValidateBatchDispatchPayload(subscription, payload, webhookgateway.DefaultLimits()) != nil {
		return result, githubquota.ResponseQuota{}
	}
	if subscription.Compiler != nil && (revision == nil || webhookgateway.ValidateCompilerRevision(subscription, *revision) != nil) {
		return result, githubquota.ResponseQuota{}
	}
	if destination.Kind != "workflow_dispatch" && destination.Kind != "repository_dispatch" {
		return result, githubquota.ResponseQuota{}
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(payload, &envelope) != nil || len(envelope) != 2 {
		return result, githubquota.ResponseQuota{}
	}
	selector, dataField, expected := "ref", "inputs", destination.Ref
	maxFields := 25
	if destination.Kind == "repository_dispatch" {
		selector, dataField, expected = "event_type", "client_payload", destination.EventType
		maxFields = 10
		if utf8.RuneCountInString(destination.EventType) > 100 {
			return result, githubquota.ResponseQuota{}
		}
	}
	var selected string
	var fields map[string]json.RawMessage
	if json.Unmarshal(envelope[selector], &selected) != nil || selected != expected ||
		json.Unmarshal(envelope[dataField], &fields) != nil || fields == nil || len(fields) > maxFields {
		return result, githubquota.ResponseQuota{}
	}
	if (destination.Kind == "workflow_dispatch" && (destination.Workflow == "" || destination.Ref == "")) ||
		(destination.Kind == "repository_dispatch" && destination.EventType == "") {
		return result, githubquota.ResponseQuota{}
	}
	var observationErr error
	observe := func(quota githubquota.ResponseQuota) {
		if d.ObserveQuota != nil && quota.HasResponse {
			observationErr = errors.Join(observationErr, d.ObserveQuota(ctx, destination.InstallationID, quota))
		}
	}
	client, quota, err := d.Client.webhookGatewayRepositoryClient(ctx, destination.InstallationID, destination.RepositoryID, observe)
	if err != nil || observationErr != nil {
		return result, quota
	}
	repository, quota, err := webhookGatewayRepositoryWithClient(ctx, client, destination.RepositoryID, observe)
	if err != nil || observationErr != nil || repository.Disabled || repository.Archived || !repository.Private || repository.Visibility != "private" {
		return result, quota
	}
	owner, name, valid := strings.Cut(repository.FullName, "/")
	if !valid || owner == "" || name == "" || strings.Contains(name, "/") {
		return result, quota
	}
	if subscription.Compiler != nil {
		if d.compilerSourcePreflight(ctx, subscription, payload, repository) != nil {
			return result, quota
		}
		head, digest, err := gatewayCurrentWorkflow(ctx, client, repository, subscription.Compiler.Dispatch.Workflow, observe)
		if err != nil || observationErr != nil || head != revision.CommitSHA || digest != revision.Digest ||
			revision.RepositoryID != destination.RepositoryID || revision.MetadataPath != subscription.Compiler.Dispatch.Workflow {
			return result, quota
		}
	}
	path := "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	if destination.Kind == "workflow_dispatch" {
		path += "/actions/workflows/" + url.PathEscape(destination.Workflow) + "/dispatches"
	} else {
		path += "/dispatches"
	}
	request, err := client.NewRequest(http.MethodPost, path, payload)
	if err != nil {
		return result, quota
	}
	request.Header.Set("X-GitHub-Api-Version", WebhookGatewayAPIVersion)
	if destination.Kind == "repository_dispatch" && request.ContentLength >= 64<<10 {
		_ = request.Body.Close()
		return result, quota
	}
	if ctx.Err() != nil {
		return result, quota
	}
	// Use the existing authenticated HTTP client, but bound error-body reads
	// before go-github can decode or retain an unbounded error response.
	httpClient := client.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := httpClient.Do(request.WithContext(ctx))
	if err != nil {
		result.TransportOutcome = "unknown"
		quota := gatewayResponseQuota(nil, err)
		var tokenErr *ghinstallation.HTTPError
		if errors.As(err, &tokenErr) || errors.Is(err, webhookgateway.ErrRequestNotSent) {
			result.TransportOutcome = "not-sent"
		}
		d.observe(ctx, destination.InstallationID, quota)
		return result, quota
	}
	defer func() { _ = response.Body.Close() }()
	now := time.Now().UTC()
	quota = githubquota.ParseResponse(response.Header, response.StatusCode, now)
	result.TransportOutcome = "response"
	result.StatusCode = response.StatusCode
	result.RetryAfter = response.Header.Get("Retry-After")
	result.RateLimitRemaining = response.Header.Get("X-RateLimit-Remaining")
	result.RateLimitReset = response.Header.Get("X-RateLimit-Reset")
	if response.StatusCode >= http.StatusBadRequest || (response.StatusCode == http.StatusOK && destination.Kind == "workflow_dispatch") {
		body, readErr := io.ReadAll(io.LimitReader(response.Body, webhookGatewayResponseLimit+1))
		if readErr == nil && len(body) <= webhookGatewayResponseLimit {
			if response.StatusCode >= http.StatusBadRequest {
				result.Body = safeGatewayErrorBody(body)
			} else {
				var accepted struct {
					WorkflowRunID int64 `json:"workflow_run_id"`
				}
				if json.Unmarshal(body, &accepted) == nil && accepted.WorkflowRunID > 0 {
					result.WorkflowRunID = accepted.WorkflowRunID
				}
			}
		}
	}
	d.observe(ctx, destination.InstallationID, quota)
	return result, quota
}

func (d WebhookGatewayDispatcher) observe(ctx context.Context, installationID int64, quota githubquota.ResponseQuota) {
	if d.ObserveQuota != nil && quota.HasResponse {
		_ = d.ObserveQuota(ctx, installationID, quota)
	}
}

func safeGatewayErrorBody(body []byte) json.RawMessage {
	var value struct {
		Message string            `json:"message"`
		Errors  []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(body, &value) != nil {
		return nil
	}
	type safeError struct {
		Code string `json:"code"`
	}
	safe := struct {
		Message string      `json:"message,omitempty"`
		Errors  []safeError `json:"errors,omitempty"`
	}{}
	message := strings.ToLower(strings.TrimSpace(value.Message))
	for _, canonical := range []string{
		"API rate limit exceeded", "You have exceeded a secondary rate limit",
		"You have triggered an abuse detection mechanism",
	} {
		if strings.HasPrefix(message, strings.ToLower(canonical)) {
			safe.Message = canonical
			break
		}
	}
	for _, canonical := range []string{
		"Workflow does not have 'workflow_dispatch' trigger", "Workflow is disabled",
		"Workflow has been disabled", "Workflow has been deleted", "Not Found",
		"Resource not accessible by integration", "Resource not accessible by personal access token",
		"Bad credentials", "Validation Failed",
	} {
		if message == strings.ToLower(canonical) {
			safe.Message = canonical
			break
		}
	}
	for _, raw := range value.Errors {
		var entry safeError
		if json.Unmarshal(raw, &entry) != nil {
			continue
		}
		switch entry.Code {
		case "missing", "missing_field", "invalid", "already_exists", "unprocessable":
			safe.Errors = append(safe.Errors, entry)
		}
		if len(safe.Errors) == 16 {
			break
		}
	}
	if safe.Message == "" && len(safe.Errors) == 0 {
		return nil
	}
	encoded, _ := json.Marshal(safe)
	return encoded
}

func gatewayResponseQuota(response *github.Response, err error) githubquota.ResponseQuota {
	if response != nil && response.Response != nil {
		return workflowRunResponseQuota(response)
	}
	var tokenErr *ghinstallation.HTTPError
	if errors.As(err, &tokenErr) && tokenErr.Response != nil {
		return githubquota.ParseResponse(tokenErr.Response.Header, tokenErr.Response.StatusCode, time.Now().UTC())
	}
	return githubquota.ResponseQuota{}
}
