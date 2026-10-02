package server

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var adminRepositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]*[A-Za-z0-9_-][A-Za-z0-9._-]*$`)

func (oauth *githubOAuth) updateAdminAuthorization(ctx context.Context, session *oauthSession) {
	session.Admin = false
	session.AdminRepository = oauth.config.WorkspaceRepository
	session.AdminRepositoryID = 0
	if session.AdminRepository == "" {
		return
	}
	if session.AccessToken == "" {
		oauth.logBranch("admin.repository_token_missing")
		return
	}
	id, err := oauth.workspaceRepositoryID(ctx)
	if err != nil {
		oauth.logBranch("admin.workspace_identity_unavailable")
		return
	}
	session.AdminRepositoryID = id
	owner, repository, ok := strings.Cut(session.AdminRepository, "/")
	if !ok || !adminRepositoryPattern.MatchString(session.AdminRepository) {
		oauth.logBranch("admin.repository_invalid")
		return
	}
	endpoint := strings.NewReplacer(
		"{owner}", url.PathEscape(owner),
		"{repo}", url.PathEscape(repository),
	).Replace(oauth.config.RepositoryURL)
	var payload struct {
		ID          int64  `json:"id"`
		FullName    string `json:"full_name"`
		Permissions *struct {
			Admin    bool `json:"admin"`
			Maintain bool `json:"maintain"`
		} `json:"permissions"`
	}
	if err := oauth.githubJSON(ctx, http.MethodGet, endpoint, session.AccessToken, nil, &payload); err != nil {
		oauth.logBranch("admin.repository_request_failed")
		return
	}
	if payload.ID <= 0 || !strings.EqualFold(payload.FullName, session.AdminRepository) || payload.Permissions == nil {
		oauth.logBranch("admin.repository_permissions_missing")
		return
	}
	session.AdminRepositoryID, err = oauth.bindWorkspaceRepositoryID(ctx, payload.ID)
	if err != nil {
		oauth.logBranch("admin.workspace_identity_unavailable")
		return
	}
	if payload.ID != session.AdminRepositoryID {
		oauth.logBranch("admin.repository_permissions_missing")
		return
	}
	session.Admin = payload.Permissions.Admin || payload.Permissions.Maintain
	if session.Admin {
		oauth.logBranch("admin.repository_allowed")
	} else {
		oauth.logBranch("admin.repository_denied")
	}
}
