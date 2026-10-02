package server

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

func (oauth *githubOAuth) workspaceIdentityKey() string {
	return oauth.revocationPrefix() + "oauth-workspace:" + authorizationDigest(strings.ToLower(oauth.config.WorkspaceRepository))
}

func (oauth *githubOAuth) workspaceRepositoryID(ctx context.Context) (int64, error) {
	if oauth.config.WorkspaceRepository == "" {
		return 0, nil
	}
	if oauth.store == nil {
		return 0, errors.New("workspace identity is unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, authorizationStoreTimeout)
	defer cancel()
	value, err := oauth.configStore(ctx, "GET", oauth.workspaceIdentityKey())
	if err != nil {
		return 0, err
	}
	if value == nil {
		return oauth.config.WorkspaceRepositoryID, nil
	}
	id, err := strconv.ParseInt(fmt.Sprint(value), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("workspace identity is invalid")
	}
	if oauth.config.WorkspaceRepositoryID > 0 && id != oauth.config.WorkspaceRepositoryID {
		return 0, errors.New("workspace identity does not match the host workspace")
	}
	return id, nil
}

func (oauth *githubOAuth) bindWorkspaceRepositoryID(ctx context.Context, id int64) (int64, error) {
	if id <= 0 || oauth.store == nil {
		return 0, errors.New("workspace identity is unavailable")
	}
	if oauth.config.WorkspaceRepositoryID > 0 {
		id = oauth.config.WorkspaceRepositoryID
	}
	ctx, cancel := context.WithTimeout(ctx, authorizationStoreTimeout)
	defer cancel()
	// Preserve the workspace's first resolved identity across process/session
	// namespace changes; a replacement at its old name must not inherit it.
	if _, err := oauth.configStore(ctx, "SET", oauth.workspaceIdentityKey(), strconv.FormatInt(id, 10), "NX"); err != nil {
		return 0, err
	}
	return oauth.workspaceRepositoryID(ctx)
}
