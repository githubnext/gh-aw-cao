package githubapp

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/google/go-github/v66/github"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func gatewayRead(ctx context.Context, client *github.Client, endpoint string, limit int64, raw bool,
	observe func(githubquota.ResponseQuota),
) ([]byte, error) {
	request, err := client.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, gateway.ErrUnavailable
	}
	if raw {
		request.Header.Set("Accept", "application/vnd.github.raw+json")
	}
	httpClient := client.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := httpClient.Do(request.WithContext(ctx))
	if err != nil {
		return nil, gateway.ErrUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	observe(githubquota.ParseResponse(response.Header, response.StatusCode, time.Now().UTC()))
	if response.StatusCode != http.StatusOK {
		return nil, &GatewayAPIError{StatusCode: response.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, gateway.ErrUnavailable
	}
	return data, nil
}

func gatewayRepositoryPath(repository GatewayRepository) (string, error) {
	if !gateway.RepositoryNameOK(repository.FullName) || !repository.Private || repository.Visibility != "private" ||
		repository.Archived || repository.Disabled || repository.DefaultBranch == "" {
		return "", gateway.ErrUnauthorized
	}
	owner, name, _ := strings.Cut(repository.FullName, "/")
	return "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name), nil
}

func gatewayDefaultHead(ctx context.Context, client *github.Client, repository GatewayRepository,
	observe func(githubquota.ResponseQuota),
) (string, error) {
	prefix, err := gatewayRepositoryPath(repository)
	if err != nil {
		return "", err
	}
	data, err := gatewayRead(ctx, client, prefix+"/git/ref/heads/"+url.PathEscape(repository.DefaultBranch), 16<<10, false, observe)
	if err != nil {
		return "", err
	}
	var ref struct {
		Object struct {
			Type string `json:"type"`
			SHA  string `json:"sha"`
		} `json:"object"`
	}
	if json.Unmarshal(data, &ref) != nil || ref.Object.Type != "commit" || !gatewayCommitSHA(ref.Object.SHA) {
		return "", gateway.ErrInvalid
	}
	return ref.Object.SHA, nil
}

func gatewayCommitSHA(sha string) bool {
	if (len(sha) != 40 && len(sha) != 64) || sha != strings.ToLower(sha) {
		return false
	}
	_, err := hex.DecodeString(sha)
	return err == nil
}

func gatewayWorkflowBytes(ctx context.Context, client *github.Client, repository GatewayRepository, commit, workflow string,
	observe func(githubquota.ResponseQuota),
) ([]byte, error) {
	if !strings.HasPrefix(workflow, ".github/workflows/") || path.Base(workflow) == workflow ||
		path.Clean(workflow) != workflow || !strings.HasSuffix(workflow, ".lock.yml") || !gatewayCommitSHA(commit) {
		return nil, gateway.ErrInvalid
	}
	prefix, err := gatewayRepositoryPath(repository)
	if err != nil {
		return nil, err
	}
	segments := strings.Split(workflow, "/")
	for i := range segments {
		segments[i] = url.PathEscape(segments[i])
	}
	return gatewayRead(ctx, client, prefix+"/contents/"+strings.Join(segments, "/")+"?ref="+url.QueryEscape(commit),
		gateway.MaxWorkflowArtifactBytes, true, observe)
}

func (c *Client) DiscoverWebhookSubscriptions(ctx context.Context, binding gateway.DiscoveryRepository,
	observe func(githubquota.ResponseQuota),
) (gateway.RepositoryInventory, error) {
	if observe == nil {
		return gateway.RepositoryInventory{}, gateway.ErrInvalid
	}
	client, _, err := c.webhookGatewayRepositoryClient(ctx, binding.ReceivingInstallationID, binding.RepositoryID, observe)
	if err != nil {
		return gateway.RepositoryInventory{}, err
	}
	repository, _, err := webhookGatewayRepositoryWithClient(ctx, client, binding.RepositoryID, observe)
	if err != nil {
		return gateway.RepositoryInventory{}, err
	}
	prefix, err := gatewayRepositoryPath(repository)
	if err != nil || !strings.EqualFold(repository.FullName, binding.Repository) {
		return gateway.RepositoryInventory{}, gateway.ErrUnauthorized
	}
	if repository.OwnerType != "Organization" && repository.OwnerType != "User" {
		return gateway.RepositoryInventory{}, gateway.ErrInvalid
	}
	head, err := gatewayDefaultHead(ctx, client, repository, observe)
	if err != nil {
		return gateway.RepositoryInventory{}, err
	}
	result := gateway.RepositoryInventory{RepositoryID: repository.ID, OwnerID: repository.OwnerID,
		OwnerType: repository.OwnerType, Visibility: repository.Visibility, CommitSHA: head}
	data, err := gatewayRead(ctx, client, prefix+"/contents/.github/workflows?ref="+url.QueryEscape(head), 2<<20, false, observe)
	var apiError *GatewayAPIError
	if errors.As(err, &apiError) && apiError.StatusCode == http.StatusNotFound {
		// A selected source need not contain workflows. The repository/private
		// access check and final head recheck still gate this empty inventory.
		data, err = []byte("[]"), nil
	}
	if err != nil {
		return gateway.RepositoryInventory{}, err
	}
	var files []struct {
		Path string `json:"path"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	}
	if json.Unmarshal(data, &files) != nil || files == nil || len(files) > 512 {
		return gateway.RepositoryInventory{}, gateway.ErrInvalid
	}
	totalBytes := 0
	seen := make(map[string]bool)
	for _, file := range files {
		if !strings.HasSuffix(file.Path, ".lock.yml") {
			continue
		}
		if file.Type != "file" || path.Dir(file.Path) != ".github/workflows" || seen[file.Path] ||
			file.Size < 0 || file.Size > gateway.MaxWorkflowArtifactBytes || len(result.Workflows) >= 128 {
			return gateway.RepositoryInventory{}, gateway.ErrInvalid
		}
		seen[file.Path] = true
		lock, err := gatewayWorkflowBytes(ctx, client, repository, head, file.Path, observe)
		if err != nil {
			return gateway.RepositoryInventory{}, err
		}
		totalBytes += len(lock)
		if totalBytes > 16<<20 {
			return gateway.RepositoryInventory{}, gateway.ErrCapacity
		}
		triggers, err := gateway.ParseWorkflowManifest(lock, file.Path, gateway.DefaultLimits())
		if err != nil {
			return gateway.RepositoryInventory{}, err
		}
		declarations := make([]gateway.CompilerTrigger, 0, len(triggers))
		for _, trigger := range triggers {
			declarations = append(declarations, trigger.Declaration)
		}
		result.Workflows = append(result.Workflows, gateway.DiscoveredWorkflow{Path: file.Path,
			SHA256: gateway.MetadataDigest(lock), Triggers: declarations})
	}
	after, err := gatewayDefaultHead(ctx, client, repository, observe)
	if err != nil {
		return gateway.RepositoryInventory{}, err
	}
	if after != head {
		return gateway.RepositoryInventory{}, gateway.ErrConflict
	}
	slices.SortFunc(result.Workflows, func(a, b gateway.DiscoveredWorkflow) int { return strings.Compare(a.Path, b.Path) })
	return result, nil
}

func (c *Client) WebhookGatewayWorkflowRevision(ctx context.Context, installation, repositoryID int64, workflow string,
	observe func(githubquota.ResponseQuota),
) (string, string, error) {
	if observe == nil {
		return "", "", gateway.ErrInvalid
	}
	client, _, err := c.webhookGatewayRepositoryClient(ctx, installation, repositoryID, observe)
	if err != nil {
		return "", "", err
	}
	repository, _, err := webhookGatewayRepositoryWithClient(ctx, client, repositoryID, observe)
	if err != nil {
		return "", "", err
	}
	return gatewayCurrentWorkflow(ctx, client, repository, workflow, observe)
}

func gatewayCurrentWorkflow(ctx context.Context, client *github.Client, repository GatewayRepository, workflow string,
	observe func(githubquota.ResponseQuota),
) (string, string, error) {
	head, err := gatewayDefaultHead(ctx, client, repository, observe)
	if err != nil {
		return "", "", err
	}
	data, err := gatewayWorkflowBytes(ctx, client, repository, head, workflow, observe)
	if err != nil {
		return "", "", err
	}
	return head, gateway.MetadataDigest(data), nil
}
