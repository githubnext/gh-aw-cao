package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

const authorizationStoreTimeout = 2 * time.Second

var errAuthorizationStateUnavailable = errors.New("authorization state is unavailable")

func (oauth *githubOAuth) authorizationKey(scope string) string {
	return oauth.store.Key("oauth-authorization:" + authorizationDigest(strings.ToLower(oauth.config.WorkspaceRepository)) + ":" + scope)
}

func authorizationDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (oauth *githubOAuth) authorizationUserKey(login string) string {
	return oauth.authorizationKey("user:" + authorizationDigest(strings.ToLower(strings.TrimSpace(login))))
}

func (oauth *githubOAuth) authorizationRevision(ctx context.Context, login string) (string, error) {
	if oauth.store == nil || strings.TrimSpace(login) == "" {
		return "", errors.New("authorization state is unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, authorizationStoreTimeout)
	defer cancel()
	values, err := oauth.store.Client.DoMany(ctx, [][]string{
		{"GET", oauth.authorizationKey("all")},
		{"GET", oauth.authorizationUserKey(login)},
	})
	if err != nil {
		return "", err
	}
	if len(values) != 2 {
		return "", errors.New("authorization state response is invalid")
	}
	var revisions [2]string
	for index, value := range values {
		if value != nil {
			revisions[index] = fmt.Sprint(value)
		}
	}
	if revisions[0] == "" && revisions[1] == "" {
		return "", nil
	}
	return revisions[0] + ":" + revisions[1], nil
}

func (oauth *githubOAuth) authorizationCurrent(ctx context.Context, session oauthSession) bool {
	revision, err := oauth.authorizationRevision(ctx, session.Login)
	if err != nil {
		oauth.logBranch("authorization.state_unavailable")
		return false
	}
	return revision == session.AuthorizationRevision
}

type authorizationWebhook struct {
	Action     string `json:"action"`
	Repository struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
	} `json:"repository"`
	Organization struct {
		Login string `json:"login"`
	} `json:"organization"`
	Member struct {
		Login string `json:"login"`
	} `json:"member"`
	Membership struct {
		User struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"membership"`
	Changes struct {
		Login struct {
			From string `json:"from"`
		} `json:"login"`
	} `json:"changes"`
}

func (oauth *githubOAuth) authorizationOrganization(org string) bool {
	if org == "" {
		return false
	}
	owner, _, _ := strings.Cut(oauth.config.WorkspaceRepository, "/")
	if strings.EqualFold(org, owner) {
		return true
	}
	for _, allowed := range oauth.config.AllowedOrganizations {
		if strings.EqualFold(org, strings.TrimSpace(allowed)) {
			return true
		}
	}
	for _, allowed := range oauth.config.AllowedTeams {
		owner, _, _ := strings.Cut(allowed, "/")
		if strings.EqualFold(org, strings.TrimSpace(owner)) {
			return true
		}
	}
	return false
}

func (oauth *githubOAuth) authorizationWebhookScope(ctx context.Context, event GitHubWebhook) (bool, string, bool, error) {
	if !slices.Contains([]string{"member", "membership", "organization", "team", "team_add", "repository"}, event.Event) {
		return false, "", false, nil
	}
	var payload authorizationWebhook
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return true, "", false, errors.New("invalid authorization webhook payload")
	}
	workspaceID, err := oauth.workspaceRepositoryID(ctx)
	if err != nil {
		return true, "", false, errors.Join(errAuthorizationStateUnavailable, err)
	}
	workspace := workspaceID > 0 && payload.Repository.ID == workspaceID
	organization := oauth.authorizationOrganization(payload.Organization.Login)
	var login string
	var invalidate bool
	switch event.Event {
	case "member":
		invalidate = workspace && slices.Contains([]string{"added", "removed", "edited"}, payload.Action)
		login = payload.Member.Login
	case "membership":
		invalidate = organization && slices.Contains([]string{"added", "removed"}, payload.Action)
		login = payload.Member.Login
	case "organization":
		switch payload.Action {
		case "member_added", "member_removed":
			invalidate = organization
			login = payload.Membership.User.Login
		case "deleted", "renamed":
			invalidate = organization || oauth.authorizationOrganization(payload.Changes.Login.From)
		}
	case "team":
		switch payload.Action {
		case "added_to_repository", "removed_from_repository":
			invalidate = workspace
		case "edited", "deleted":
			invalidate = workspace || (payload.Repository.ID == 0 && organization)
		}
	case "team_add":
		invalidate = workspace
	case "repository":
		invalidate = workspace && slices.Contains([]string{"renamed", "transferred", "deleted", "privatized", "publicized"}, payload.Action)
	}
	if invalidate && (event.Event == "member" || event.Event == "membership" ||
		(event.Event == "organization" && strings.HasPrefix(payload.Action, "member_"))) {
		if strings.TrimSpace(login) == "" {
			return true, "", false, errors.New("authorization webhook is missing the affected user")
		}
	}
	return true, strings.TrimSpace(login), invalidate, nil
}

func (oauth *githubOAuth) invalidateAuthorization(ctx context.Context, event GitHubWebhook, login string) (bool, error) {
	if oauth.store == nil {
		return false, errors.New("authorization state is unavailable")
	}
	revision, err := randomToken(32)
	if err != nil {
		return false, err
	}
	key := oauth.authorizationKey("all")
	if login != "" {
		key = oauth.authorizationUserKey(login)
	}
	// Commit the invalidation and its delivery marker together so retries
	// cannot acknowledge a permission change without publishing it.
	const script = `
if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2])
redis.call("SET", KEYS[1], "1", "EX", ARGV[3])
return 1`
	ctx, cancel := context.WithTimeout(ctx, authorizationStoreTimeout)
	defer cancel()
	result, err := oauth.configStore(ctx, "EVAL", script, "2",
		oauth.authorizationKey("delivery:"+authorizationDigest(event.Delivery)), key, revision,
		strconv.FormatInt(int64(sessionTTL.Seconds()), 10),
		strconv.FormatInt(int64(deliveryTTL.Seconds()), 10),
	)
	if err != nil {
		oauth.logBranch("webhook.authorization_invalidation_failed")
		return false, err
	}
	if fmt.Sprint(result) == "0" {
		oauth.logBranch("webhook.authorization_duplicate")
		return false, nil
	}
	if fmt.Sprint(result) != "1" {
		return false, errors.New("authorization invalidation response is invalid")
	}
	oauth.logBranch("webhook.authorization_invalidated")
	recordOAuthDecision(ctx, "webhook_invalidation", "accepted")
	return true, nil
}
