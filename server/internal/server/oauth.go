package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	sessionCookieName = "cao_session"
	csrfCookieName    = "cao_csrf"
	sessionTTL        = 30 * 24 * time.Hour
	tokenRefreshSkew  = 5 * time.Minute
)

type GitHubOAuthConfig struct {
	ClientID              string
	ClientSecret          string
	RedirectURL           string
	SessionSecret         string
	PreviousSessionSecret string
	AllowedOrganizations  []string
	AllowedTeams          []string
	AuthURL               string
	TokenURL              string
	UserURL               string
	OrgMembershipURL      string
	TeamMembershipURL     string
	RevokeURL             string
	HTTPClient            *http.Client
}

type githubOAuth struct {
	config GitHubOAuthConfig
	client *http.Client
	store  *redisx.Store
	key    []byte
	keys   map[string][]byte
	log    func(string)
}

type oauthSession struct {
	ID             string    `json:"id"`
	Login          string    `json:"login"`
	AccessToken    string    `json:"accessToken"`
	RefreshToken   string    `json:"refreshToken"`
	AccessExpires  time.Time `json:"accessExpires"`
	RefreshExpires time.Time `json:"refreshExpires"`
	CSRFToken      string    `json:"csrfToken"`
}

type tokenResponse struct {
	AccessToken           string `json:"access_token"`
	RefreshToken          string `json:"refresh_token"`
	ExpiresIn             int64  `json:"expires_in"`
	RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
	TokenType             string `json:"token_type"`
	Error                 string `json:"error"`
	ErrorDescription      string `json:"error_description"`
}

func (config *GitHubOAuthConfig) validate() error {
	if strings.TrimSpace(config.ClientID) == "" {
		return errors.New("GitHub OAuth client ID is required")
	}
	if strings.TrimSpace(config.ClientSecret) == "" {
		return errors.New("GitHub OAuth client secret is required")
	}
	if strings.TrimSpace(config.RedirectURL) == "" {
		return errors.New("GitHub OAuth redirect URL is required")
	}
	if strings.TrimSpace(config.SessionSecret) == "" || len(config.SessionSecret) < 32 {
		return errors.New("session secret must contain at least 32 characters")
	}
	if config.PreviousSessionSecret != "" && len(config.PreviousSessionSecret) < 32 {
		return errors.New("previous session secret must contain at least 32 characters")
	}
	if len(config.AllowedOrganizations) == 0 && len(config.AllowedTeams) == 0 {
		return errors.New("GitHub OAuth authorization requires at least one allowed organization or team")
	}
	if config.AuthURL == "" {
		config.AuthURL = "https://github.com/login/oauth/authorize"
	}
	if config.TokenURL == "" {
		config.TokenURL = "https://github.com/login/oauth/access_token"
	}
	if config.UserURL == "" {
		config.UserURL = "https://api.github.com/user"
	}
	if config.OrgMembershipURL == "" {
		config.OrgMembershipURL = "https://api.github.com/user/memberships/orgs/{org}"
	}
	if config.TeamMembershipURL == "" {
		config.TeamMembershipURL = "https://api.github.com/orgs/{org}/teams/{team}/memberships/{user}"
	}
	if config.RevokeURL == "" {
		config.RevokeURL = "https://api.github.com/applications/{client_id}/token"
	}
	return nil
}

func newGitHubOAuth(config GitHubOAuthConfig, store *redisx.Store) *githubOAuth {
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	sum := sha256.Sum256([]byte(config.SessionSecret))
	keys := map[string][]byte{sessionKeyID(sum[:]): sum[:]}
	if config.PreviousSessionSecret != "" {
		previous := sha256.Sum256([]byte(config.PreviousSessionSecret))
		keys[sessionKeyID(previous[:])] = previous[:]
	}
	return &githubOAuth{
		config: config,
		client: client,
		store:  store,
		key:    sum[:],
		keys:   keys,
		log: func(branch string) {
			serverLog.Printf("oauth branch=%s", branch)
		},
	}
}

func (oauth *githubOAuth) logBranch(branch string) {
	oauth.emitAuthBranch(branch)
}

func (oauth *githubOAuth) emitAuthBranch(branch string) {
	if oauth.log != nil {
		oauth.log(branch)
	}
}

func (oauth *githubOAuth) login(response http.ResponseWriter, request *http.Request) {
	oauth.retryPendingRevocations(request.Context(), 8)
	state, err := randomToken(32)
	if err != nil {
		oauth.logBranch("login.state_generation_failed")
		writeError(response, http.StatusInternalServerError, "failed to initialize login")
		return
	}
	http.SetCookie(response, &http.Cookie{
		Name:     "cao_oauth_state",
		Value:    oauth.sign(state),
		Path:     "/auth/",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   600,
	})
	target, _ := url.Parse(oauth.config.AuthURL)
	values := target.Query()
	values.Set("client_id", oauth.config.ClientID)
	values.Set("redirect_uri", oauth.config.RedirectURL)
	values.Set("state", state)
	values.Set("scope", "read:org")
	if request.URL.Query().Get("select_account") == "1" {
		oauth.logBranch("login.account_selection_requested")
		values.Set("prompt", "select_account")
	} else {
		oauth.logBranch("login.default_account_requested")
	}
	target.RawQuery = values.Encode()
	oauth.logBranch("login.redirected")
	http.Redirect(response, request, target.String(), http.StatusFound)
}

func (oauth *githubOAuth) loggedOut(response http.ResponseWriter, _ *http.Request) {
	oauth.logBranch("logged_out.rendered")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(response, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed out · CAO</title></head>
<body><main><h1>You are signed out</h1><p><a href="/auth/login">Sign in with GitHub</a></p></main></body>
</html>`)
}

func (oauth *githubOAuth) callback(response http.ResponseWriter, request *http.Request) {
	if !oauth.validState(request) {
		serverLog.Printf("oauth callback rejected invalid state")
		oauth.logBranch("callback.state_rejected")
		writeError(response, http.StatusBadRequest, "invalid OAuth state")
		return
	}
	oauth.clearStateCookie(response)
	code := strings.TrimSpace(request.URL.Query().Get("code"))
	if code == "" {
		oauth.logBranch("callback.code_missing")
		writeError(response, http.StatusBadRequest, "OAuth code is required")
		return
	}
	tokens, err := oauth.exchange(request.Context(), url.Values{
		"client_id":     {oauth.config.ClientID},
		"client_secret": {oauth.config.ClientSecret},
		"code":          {code},
		"redirect_uri":  {oauth.config.RedirectURL},
	})
	if err != nil {
		serverLog.Printf("oauth exchange failed")
		oauth.logBranch("callback.exchange_failed")
		writeError(response, http.StatusUnauthorized, "GitHub OAuth exchange failed")
		return
	}
	login, err := oauth.authorizedLogin(request.Context(), tokens.AccessToken)
	if err != nil {
		serverLog.Printf("oauth authorization failed")
		oauth.logBranch("callback.authorization_failed")
		writeError(response, http.StatusForbidden, "GitHub authorization failed")
		return
	}
	sessionID, err := randomToken(32)
	if err != nil {
		oauth.logBranch("callback.session_id_generation_failed")
		writeError(response, http.StatusInternalServerError, "failed to create session")
		return
	}
	csrfToken, err := randomToken(32)
	if err != nil {
		oauth.logBranch("callback.csrf_generation_failed")
		writeError(response, http.StatusInternalServerError, "failed to create session")
		return
	}
	now := time.Now().UTC()
	session := oauthSession{
		ID:             sessionID,
		Login:          login,
		AccessToken:    tokens.AccessToken,
		RefreshToken:   tokens.RefreshToken,
		AccessExpires:  now.Add(time.Duration(tokens.ExpiresIn) * time.Second),
		RefreshExpires: now.Add(time.Duration(tokens.RefreshTokenExpiresIn) * time.Second),
		CSRFToken:      csrfToken,
	}
	if tokens.ExpiresIn == 0 {
		oauth.logBranch("callback.access_expiry_defaulted")
		session.AccessExpires = now.Add(time.Hour)
	} else {
		oauth.logBranch("callback.access_expiry_provided")
	}
	if tokens.RefreshTokenExpiresIn <= 0 {
		oauth.logBranch("callback.refresh_expiry_defaulted")
		session.RefreshExpires = now.Add(sessionTTL)
	} else {
		oauth.logBranch("callback.refresh_expiry_provided")
	}
	if err := oauth.saveSession(request.Context(), session); err != nil {
		serverLog.Printf("oauth session save failed")
		oauth.logBranch("callback.session_save_failed")
		writeError(response, http.StatusServiceUnavailable, "failed to create session")
		return
	}
	oauth.setSessionCookies(response, session)
	serverLog.Printf("oauth callback completed")
	oauth.logBranch("callback.succeeded")
	http.Redirect(response, request, "/", http.StatusFound)
}

func (oauth *githubOAuth) logout(response http.ResponseWriter, request *http.Request) {
	if err := oauth.clearRequestSession(response, request); err != nil {
		oauth.logBranch("logout.failed")
		writeError(response, http.StatusServiceUnavailable, "GitHub credential revocation is temporarily unavailable")
		return
	}
	oauth.logBranch("logout.succeeded")
	response.WriteHeader(http.StatusNoContent)
}

func (oauth *githubOAuth) switchAccount(response http.ResponseWriter, request *http.Request) {
	if err := oauth.clearRequestSession(response, request); err != nil {
		oauth.logBranch("switch_account.failed")
		writeError(response, http.StatusServiceUnavailable, "GitHub credential revocation is temporarily unavailable")
		return
	}
	oauth.logBranch("switch_account.succeeded")
	writeJSON(response, http.StatusOK, map[string]string{"loginUrl": "/auth/login?select_account=1"})
}

func (oauth *githubOAuth) currentAccount(response http.ResponseWriter, request *http.Request) {
	session, ok := oauth.loadRequestSession(request)
	if !ok {
		oauth.logBranch("current_account.session_missing")
		writeError(response, http.StatusUnauthorized, "GitHub authentication is required")
		return
	}
	oauth.logBranch("current_account.succeeded")
	writeJSON(response, http.StatusOK, map[string]string{"login": session.Login})
}

func (oauth *githubOAuth) clearRequestSession(response http.ResponseWriter, request *http.Request) error {
	session, ok := oauth.loadRequestSession(request)
	sealed := ""
	if ok {
		staged, stagedValue, err := oauth.stageRevocation(request.Context(), session.ID)
		if err != nil {
			serverLog.Printf("oauth credential revocation staging failed")
			oauth.logBranch("session_clear.revocation_staging_failed")
			return err
		}
		session = staged
		sealed = stagedValue
		if sealed == "" {
			oauth.logBranch("session_clear.already_absent")
			ok = false
		} else {
			oauth.logBranch("session_clear.revocation_staged")
		}
	} else {
		oauth.logBranch("session_clear.session_missing")
	}
	oauth.clearSessionCookies(response)
	if ok {
		if err := oauth.revokeCredentials(request.Context(), session); err != nil {
			serverLog.Printf("oauth credential revocation queued")
			oauth.logBranch("session_clear.revocation_queued")
		} else {
			if err := oauth.completeRevocation(request.Context(), session.ID, sealed); err != nil {
				oauth.logBranch("session_clear.revocation_completion_failed")
			} else {
				oauth.logBranch("session_clear.revocation_completed")
			}
		}
	}
	return nil
}

func (oauth *githubOAuth) session(response http.ResponseWriter, request *http.Request) (oauthSession, bool) {
	cookie, err := request.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		oauth.logBranch("session.cookie_missing")
		return oauthSession{}, false
	}
	session, expected, err := oauth.loadSessionRecord(request.Context(), cookie.Value)
	if err != nil {
		oauth.logBranch("session.load_failed")
		return oauthSession{}, false
	}
	if time.Now().UTC().Add(tokenRefreshSkew).Before(session.AccessExpires) {
		oauth.logBranch("session.active")
		return session, true
	}
	if session.RefreshToken == "" || time.Now().UTC().After(session.RefreshExpires) {
		if err := oauth.deleteSession(request.Context(), session.ID); err != nil {
			oauth.logBranch("session.expired_delete_failed")
		} else {
			oauth.logBranch("session.expired_deleted")
		}
		oauth.clearSessionCookies(response)
		return oauthSession{}, false
	}
	refreshed, err := oauth.exchange(request.Context(), url.Values{
		"client_id":     {oauth.config.ClientID},
		"client_secret": {oauth.config.ClientSecret},
		"grant_type":    {"refresh_token"},
		"refresh_token": {session.RefreshToken},
	})
	if err != nil {
		serverLog.Printf("oauth token refresh failed")
		oauth.logBranch("refresh.exchange_failed")
		oauth.invalidateSession(response, request.Context(), session.ID)
		return oauthSession{}, false
	}
	now := time.Now().UTC()
	session.AccessToken = refreshed.AccessToken
	if refreshed.RefreshToken != "" {
		oauth.logBranch("refresh.refresh_token_rotated")
		session.RefreshToken = refreshed.RefreshToken
	} else {
		oauth.logBranch("refresh.refresh_token_reused")
	}
	session.AccessExpires = now.Add(time.Duration(refreshed.ExpiresIn) * time.Second)
	if refreshed.RefreshTokenExpiresIn > 0 {
		oauth.logBranch("refresh.refresh_expiry_updated")
		session.RefreshExpires = now.Add(time.Duration(refreshed.RefreshTokenExpiresIn) * time.Second)
	} else {
		oauth.logBranch("refresh.refresh_expiry_retained")
	}
	if refreshed.ExpiresIn <= 0 {
		oauth.logBranch("refresh.access_expiry_defaulted")
		session.AccessExpires = now.Add(time.Hour)
	} else {
		oauth.logBranch("refresh.access_expiry_provided")
	}
	login, err := oauth.authorizedLogin(request.Context(), refreshed.AccessToken)
	if err != nil || !strings.EqualFold(login, session.Login) {
		if oauth.revokeCredentials(request.Context(), session) != nil {
			if oauth.queueRevocation(request.Context(), session) != nil {
				oauth.logBranch("refresh.rejected_revocation_queue_failed")
			} else {
				oauth.logBranch("refresh.rejected_revocation_queued")
			}
		} else {
			oauth.logBranch("refresh.rejected_credentials_revoked")
		}
		oauth.invalidateSession(response, request.Context(), session.ID)
		serverLog.Printf("oauth authorization revalidation failed")
		oauth.logBranch("refresh.authorization_rejected")
		return oauthSession{}, false
	}
	saved, err := oauth.saveSessionIfUnchanged(request.Context(), session, expected)
	if err != nil {
		serverLog.Printf("oauth refreshed session save failed")
		oauth.logBranch("refresh.session_save_failed")
		if oauth.revokeCredentials(request.Context(), session) != nil {
			if oauth.queueRevocation(request.Context(), session) != nil {
				oauth.logBranch("refresh.save_failed_revocation_queue_failed")
			} else {
				oauth.logBranch("refresh.save_failed_revocation_queued")
			}
		} else {
			oauth.logBranch("refresh.save_failed_credentials_revoked")
		}
		oauth.invalidateSession(response, request.Context(), session.ID)
		return oauthSession{}, false
	}
	if !saved {
		serverLog.Printf("oauth refreshed session superseded")
		oauth.logBranch("refresh.session_superseded")
		if oauth.revokeCredentials(request.Context(), session) != nil {
			if oauth.queueRevocation(request.Context(), session) != nil {
				oauth.logBranch("refresh.superseded_revocation_queue_failed")
			} else {
				oauth.logBranch("refresh.superseded_revocation_queued")
			}
		} else {
			oauth.logBranch("refresh.superseded_credentials_revoked")
		}
		oauth.clearSessionCookies(response)
		return oauthSession{}, false
	}
	serverLog.Printf("oauth session refreshed")
	oauth.logBranch("refresh.succeeded")
	return session, true
}

func (oauth *githubOAuth) invalidateSession(response http.ResponseWriter, ctx context.Context, sessionID string) {
	session, sealed, err := oauth.stageRevocation(ctx, sessionID)
	if err != nil {
		serverLog.Printf("oauth credential revocation staging failed")
		oauth.logBranch("invalidation.revocation_staging_failed")
		oauth.clearSessionCookies(response)
		return
	}
	oauth.clearSessionCookies(response)
	if sealed == "" {
		oauth.logBranch("invalidation.session_absent")
		return
	}
	if oauth.revokeCredentials(ctx, session) == nil {
		if oauth.completeRevocation(ctx, session.ID, sealed) != nil {
			oauth.logBranch("invalidation.revocation_completion_failed")
		} else {
			oauth.logBranch("invalidation.revocation_completed")
		}
	} else {
		oauth.logBranch("invalidation.revocation_deferred")
	}
}

func (oauth *githubOAuth) requestHasSession(request *http.Request) bool {
	_, ok := oauth.loadRequestSession(request)
	return ok
}

func (oauth *githubOAuth) validState(request *http.Request) bool {
	state := request.URL.Query().Get("state")
	cookie, err := request.Cookie("cao_oauth_state")
	return err == nil && state != "" && constantTimeTokenEqual(cookie.Value, oauth.sign(state))
}

func (oauth *githubOAuth) exchange(ctx context.Context, values url.Values) (tokenResponse, error) {
	// #nosec G704 -- endpoints are fixed GitHub defaults in production and test-only overrides are explicit configuration.
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, oauth.config.TokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		oauth.logBranch("exchange.request_creation_failed")
		return tokenResponse{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := oauth.client.Do(request) // #nosec G704 -- see endpoint validation note above.
	if err != nil {
		oauth.logBranch("exchange.request_failed")
		return tokenResponse{}, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		oauth.logBranch("exchange.status_rejected")
		return tokenResponse{}, errors.New("GitHub OAuth token endpoint rejected the request")
	}
	var tokens tokenResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&tokens); err != nil {
		oauth.logBranch("exchange.response_decode_failed")
		return tokenResponse{}, err
	}
	if tokens.Error != "" || tokens.AccessToken == "" {
		oauth.logBranch("exchange.token_missing")
		return tokenResponse{}, errors.New("GitHub OAuth token endpoint did not return an access token")
	}
	oauth.logBranch("exchange.succeeded")
	return tokens, nil
}

func (oauth *githubOAuth) authorizedLogin(ctx context.Context, accessToken string) (string, error) {
	login, err := oauth.githubLogin(ctx, accessToken)
	if err != nil {
		oauth.logBranch("authorization.identity_failed")
		return "", err
	}
	for _, org := range oauth.config.AllowedOrganizations {
		if oauth.orgAuthorized(ctx, accessToken, org) {
			oauth.logBranch("authorization.organization_allowed")
			return login, nil
		}
	}
	for _, team := range oauth.config.AllowedTeams {
		parts := strings.Split(team, "/")
		if len(parts) == 2 && oauth.teamAuthorized(ctx, accessToken, parts[0], parts[1], login) {
			oauth.logBranch("authorization.team_allowed")
			return login, nil
		}
		if len(parts) != 2 {
			oauth.logBranch("authorization.team_policy_invalid")
		}
	}
	oauth.logBranch("authorization.denied")
	return "", errors.New("GitHub user is not authorized")
}

func (oauth *githubOAuth) githubLogin(ctx context.Context, accessToken string) (string, error) {
	var payload struct {
		Login string `json:"login"`
	}
	if err := oauth.githubJSON(ctx, http.MethodGet, oauth.config.UserURL, accessToken, nil, &payload); err != nil {
		oauth.logBranch("identity.request_failed")
		return "", err
	}
	if strings.TrimSpace(payload.Login) == "" {
		oauth.logBranch("identity.login_missing")
		return "", errors.New("GitHub user response did not include a login")
	}
	oauth.logBranch("identity.loaded")
	return payload.Login, nil
}

func (oauth *githubOAuth) orgAuthorized(ctx context.Context, accessToken, org string) bool {
	var payload struct {
		State string `json:"state"`
	}
	endpoint := strings.ReplaceAll(oauth.config.OrgMembershipURL, "{org}", url.PathEscape(org))
	if err := oauth.githubJSON(ctx, http.MethodGet, endpoint, accessToken, nil, &payload); err != nil {
		oauth.logBranch("organization_membership.request_failed")
		return false
	}
	if payload.State != "active" {
		oauth.logBranch("organization_membership.inactive")
		return false
	}
	oauth.logBranch("organization_membership.active")
	return true
}

func (oauth *githubOAuth) teamAuthorized(ctx context.Context, accessToken, org, team, login string) bool {
	var payload struct {
		State string `json:"state"`
	}
	endpoint := strings.ReplaceAll(oauth.config.TeamMembershipURL, "{org}", url.PathEscape(org))
	endpoint = strings.ReplaceAll(endpoint, "{team}", url.PathEscape(team))
	endpoint = strings.ReplaceAll(endpoint, "{user}", url.PathEscape(login))
	if err := oauth.githubJSON(ctx, http.MethodGet, endpoint, accessToken, nil, &payload); err != nil {
		oauth.logBranch("team_membership.request_failed")
		return false
	}
	if payload.State != "active" {
		oauth.logBranch("team_membership.inactive")
		return false
	}
	oauth.logBranch("team_membership.active")
	return true
}

func (oauth *githubOAuth) revoke(ctx context.Context, token string) error {
	if token == "" {
		oauth.logBranch("revocation.token_absent")
		return nil
	}
	body, _ := json.Marshal(map[string]string{"access_token": token})
	endpoint := strings.ReplaceAll(oauth.config.RevokeURL, "{client_id}", url.PathEscape(oauth.config.ClientID))
	err := oauth.githubJSON(ctx, http.MethodDelete, endpoint, "", bytes.NewReader(body), nil, func(request *http.Request, _ *map[int]bool) {
		request.SetBasicAuth(oauth.config.ClientID, oauth.config.ClientSecret)
	}, acceptNotFound)
	if err != nil {
		oauth.logBranch("revocation.request_failed")
	} else {
		oauth.logBranch("revocation.request_succeeded")
	}
	return err
}

func (oauth *githubOAuth) revokeCredentials(ctx context.Context, session oauthSession) error {
	return errors.Join(
		oauth.revoke(ctx, session.AccessToken),
		oauth.revoke(ctx, session.RefreshToken),
	)
}

func (oauth *githubOAuth) stageRevocation(ctx context.Context, sessionID string) (oauthSession, string, error) {
	const script = `
local value = redis.call("GET", KEYS[1])
if not value then return false end
redis.call("SET", KEYS[2], value)
redis.call("SADD", KEYS[3], KEYS[2])
redis.call("DEL", KEYS[1])
return value`
	value, err := oauth.configStore(
		ctx, "EVAL", script, "3",
		oauth.sessionKey(sessionID),
		oauth.revocationKey(sessionID),
		oauth.revocationIndexKey(),
	)
	if err != nil {
		return oauthSession{}, "", err
	}
	if value == nil || fmt.Sprint(value) == "0" {
		return oauthSession{}, "", nil
	}
	sealed := fmt.Sprint(value)
	plain, err := oauth.open(sealed)
	if err != nil {
		return oauthSession{}, "", err
	}
	var session oauthSession
	if err := json.Unmarshal(plain, &session); err != nil {
		return oauthSession{}, "", err
	}
	return session, sealed, nil
}

func (oauth *githubOAuth) queueRevocation(ctx context.Context, session oauthSession) error {
	retryID, err := randomToken(16)
	if err != nil {
		return err
	}
	session.ID = retryID
	data, err := json.Marshal(session) // #nosec G117 -- token fields are sealed with AES-GCM before entering the revocation queue.
	if err != nil {
		return err
	}
	sealed, err := oauth.seal(data)
	if err != nil {
		return err
	}
	const script = `
redis.call("SET", KEYS[1], ARGV[1])
return redis.call("SADD", KEYS[2], KEYS[1])`
	_, err = oauth.configStore(
		ctx, "EVAL", script, "2",
		oauth.revocationKey(session.ID),
		oauth.revocationIndexKey(),
		sealed,
	)
	return err
}

func (oauth *githubOAuth) completeRevocation(ctx context.Context, sessionID, expected string) error {
	const script = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return redis.call("SREM", KEYS[2], KEYS[1])`
	_, err := oauth.configStore(
		ctx, "EVAL", script, "2",
		oauth.revocationKey(sessionID),
		oauth.revocationIndexKey(),
		expected,
	)
	return err
}

func (oauth *githubOAuth) retryPendingRevocations(ctx context.Context, limit int) {
	for range limit {
		value, err := oauth.configStore(ctx, "SRANDMEMBER", oauth.revocationIndexKey())
		if err != nil {
			oauth.logBranch("revocation_retry.index_read_failed")
			return
		}
		if value == nil {
			oauth.logBranch("revocation_retry.queue_empty")
			return
		}
		key := fmt.Sprint(value)
		sealed, err := oauth.configStore(ctx, "GET", key)
		if err != nil {
			oauth.logBranch("revocation_retry.record_read_failed")
			return
		}
		if sealed == nil {
			if _, err := oauth.configStore(ctx, "SREM", oauth.revocationIndexKey(), key); err != nil {
				oauth.logBranch("revocation_retry.stale_index_removal_failed")
				continue
			}
			oauth.logBranch("revocation_retry.stale_index_removed")
			continue
		}
		plain, err := oauth.open(fmt.Sprint(sealed))
		if err != nil {
			oauth.logBranch("revocation_retry.decrypt_failed")
			return
		}
		var session oauthSession
		if json.Unmarshal(plain, &session) != nil {
			oauth.logBranch("revocation_retry.decode_failed")
			return
		}
		if credentialsExpired(session) {
			if oauth.completeRevocation(ctx, session.ID, fmt.Sprint(sealed)) != nil {
				oauth.logBranch("revocation_retry.expired_removal_failed")
				continue
			}
			oauth.logBranch("revocation_retry.expired_removed")
			continue
		}
		if oauth.revokeCredentials(ctx, session) != nil {
			oauth.logBranch("revocation_retry.request_failed")
			return
		}
		if oauth.completeRevocation(ctx, session.ID, fmt.Sprint(sealed)) != nil {
			oauth.logBranch("revocation_retry.completion_failed")
			continue
		}
		oauth.logBranch("revocation_retry.completed")
	}
	oauth.logBranch("revocation_retry.limit_reached")
}

func (oauth *githubOAuth) runRevocationWorker(ctx context.Context) {
	oauth.retryPendingRevocations(ctx, 16)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			oauth.logBranch("revocation_worker.stopped")
			return
		case <-ticker.C:
			oauth.logBranch("revocation_worker.tick")
			oauth.retryPendingRevocations(ctx, 16)
		}
	}
}

func credentialsExpired(session oauthSession) bool {
	expires := session.AccessExpires
	if session.RefreshExpires.After(expires) {
		expires = session.RefreshExpires
	}
	return !expires.IsZero() && time.Now().UTC().After(expires)
}

type githubRequestOption func(*http.Request, *map[int]bool)

func acceptNotFound(_ *http.Request, accepted *map[int]bool) {
	(*accepted)[http.StatusNotFound] = true
}

func (oauth *githubOAuth) githubJSON(ctx context.Context, method, endpoint, token string, body io.Reader, output any, configure ...githubRequestOption) error {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body) // #nosec G704 -- endpoints come only from validated server-side OAuth configuration.
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	accepted := map[int]bool{}
	for _, apply := range configure {
		apply(request, &accepted)
	}
	response, err := oauth.client.Do(request) // #nosec G704 -- the request endpoint is fixed server-side OAuth configuration, never user input.
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	if (response.StatusCode < 200 || response.StatusCode >= 300) && !accepted[response.StatusCode] {
		return fmt.Errorf("GitHub API returned %d", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}

func (oauth *githubOAuth) loadRequestSession(request *http.Request) (oauthSession, bool) {
	cookie, err := request.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return oauthSession{}, false
	}
	session, err := oauth.loadSession(request.Context(), cookie.Value)
	return session, err == nil
}

func (oauth *githubOAuth) loadSession(ctx context.Context, sessionID string) (oauthSession, error) {
	session, _, err := oauth.loadSessionRecord(ctx, sessionID)
	return session, err
}

func (oauth *githubOAuth) loadSessionRecord(ctx context.Context, sessionID string) (oauthSession, string, error) {
	value, err := oauth.configStore(ctx, "GET", oauth.sessionKey(sessionID))
	if err != nil || value == nil {
		return oauthSession{}, "", errors.New("session is unavailable")
	}
	sealed := fmt.Sprint(value)
	plain, err := oauth.open(sealed)
	if err != nil {
		return oauthSession{}, "", err
	}
	var session oauthSession
	if err := json.Unmarshal(plain, &session); err != nil {
		return oauthSession{}, "", err
	}
	return session, sealed, nil
}

func (oauth *githubOAuth) saveSession(ctx context.Context, session oauthSession) error {
	data, err := json.Marshal(session) // #nosec G117 -- marshaled token fields are encrypted with AES-GCM before Redis storage.
	if err != nil {
		return err
	}
	sealed, err := oauth.seal(data)
	if err != nil {
		return err
	}
	_, err = oauth.configStore(ctx, "SET", oauth.sessionKey(session.ID), sealed, "EX", fmt.Sprint(int(sessionTTL.Seconds())))
	return err
}

func (oauth *githubOAuth) saveSessionIfUnchanged(ctx context.Context, session oauthSession, expected string) (bool, error) {
	data, err := json.Marshal(session) // #nosec G117 -- token fields are sealed with AES-GCM before Redis persistence.
	if err != nil {
		return false, err
	}
	sealed, err := oauth.seal(data)
	if err != nil {
		return false, err
	}
	const script = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1`
	result, err := oauth.configStore(
		ctx, "EVAL", script, "1", oauth.sessionKey(session.ID),
		expected, sealed, fmt.Sprint(int(sessionTTL.Seconds())),
	)
	return fmt.Sprint(result) == "1", err
}

func (oauth *githubOAuth) deleteSession(ctx context.Context, sessionID string) error {
	_, err := oauth.configStore(ctx, "DEL", oauth.sessionKey(sessionID))
	return err
}

func (oauth *githubOAuth) configStore(ctx context.Context, args ...string) (any, error) {
	if oauth.store == nil {
		return nil, errors.New("session store is unavailable")
	}
	return oauth.store.Client.Do(ctx, args...)
}

func (oauth *githubOAuth) sessionKey(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return oauth.store.Key("session:" + base64.RawURLEncoding.EncodeToString(sum[:]))
}

func (oauth *githubOAuth) revocationKey(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return oauth.store.Key("oauth-revocation:" + base64.RawURLEncoding.EncodeToString(sum[:]))
}

func (oauth *githubOAuth) revocationIndexKey() string {
	return oauth.store.Key("oauth-revocations")
}

func (oauth *githubOAuth) setSessionCookies(response http.ResponseWriter, session oauthSession) {
	http.SetCookie(response, &http.Cookie{Name: sessionCookieName, Value: session.ID, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
	// #nosec G124 -- CSRF token must be browser-readable so same-origin fetch requests can mirror it in X-CSRF-Token.
	http.SetCookie(response, &http.Cookie{Name: csrfCookieName, Value: url.QueryEscape(session.CSRFToken), Path: "/", Secure: true, HttpOnly: false, SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
	oauth.clearStateCookie(response)
}

func (oauth *githubOAuth) clearSessionCookies(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	// #nosec G124 -- CSRF token cookie is intentionally not HttpOnly; it carries no session authority.
	http.SetCookie(response, &http.Cookie{Name: csrfCookieName, Value: "", Path: "/", Secure: true, HttpOnly: false, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

func (oauth *githubOAuth) clearStateCookie(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{Name: "cao_oauth_state", Value: "", Path: "/auth/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

func (oauth *githubOAuth) sign(value string) string {
	mac := hmac.New(sha256.New, oauth.key)
	_, _ = mac.Write([]byte(value))
	return value + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (oauth *githubOAuth) seal(plain []byte) (string, error) {
	block, err := aes.NewCipher(oauth.key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, plain, nil))
	return sessionKeyID(oauth.key) + "." + sealed, nil
}

func (oauth *githubOAuth) open(sealed string) ([]byte, error) {
	if parts := strings.SplitN(sealed, ".", 2); len(parts) == 2 {
		key, ok := oauth.keys[parts[0]]
		if !ok {
			return nil, errors.New("encrypted session key is unavailable")
		}
		return openWithKey(parts[1], key)
	}
	if plain, err := openWithKey(sealed, oauth.key); err == nil {
		return plain, nil
	}
	for id, key := range oauth.keys {
		if id == sessionKeyID(oauth.key) {
			continue
		}
		if plain, err := openWithKey(sealed, key); err == nil {
			return plain, nil
		}
	}
	return nil, errors.New("encrypted session is invalid")
}

func openWithKey(sealed string, key []byte) ([]byte, error) {
	data, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < aead.NonceSize() {
		return nil, errors.New("encrypted session is invalid")
	}
	return aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], nil)
}

func sessionKeyID(key []byte) string {
	sum := sha256.Sum256(key)
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

func randomToken(bytes int) (string, error) {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
