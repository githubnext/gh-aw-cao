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
	ClientID             string
	ClientSecret         string
	RedirectURL          string
	SessionSecret        string
	AllowedOrganizations []string
	AllowedTeams         []string
	AuthURL              string
	TokenURL             string
	UserURL              string
	OrgMembershipURL     string
	TeamMembershipURL    string
	RevokeURL            string
	HTTPClient           *http.Client
}

type githubOAuth struct {
	config GitHubOAuthConfig
	client *http.Client
	store  *redisx.Store
	key    []byte
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
	return &githubOAuth{config: config, client: client, store: store, key: sum[:]}
}

func (oauth *githubOAuth) login(response http.ResponseWriter, request *http.Request) {
	state, err := randomToken(32)
	if err != nil {
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
	target.RawQuery = values.Encode()
	http.Redirect(response, request, target.String(), http.StatusFound)
}

func (oauth *githubOAuth) callback(response http.ResponseWriter, request *http.Request) {
	if !oauth.validState(request) {
		writeError(response, http.StatusBadRequest, "invalid OAuth state")
		return
	}
	oauth.clearStateCookie(response)
	code := strings.TrimSpace(request.URL.Query().Get("code"))
	if code == "" {
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
		writeError(response, http.StatusUnauthorized, "GitHub OAuth exchange failed")
		return
	}
	login, err := oauth.authorizedLogin(request.Context(), tokens.AccessToken)
	if err != nil {
		writeError(response, http.StatusForbidden, "GitHub authorization failed")
		return
	}
	sessionID, err := randomToken(32)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "failed to create session")
		return
	}
	csrfToken, err := randomToken(32)
	if err != nil {
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
		session.AccessExpires = now.Add(time.Hour)
	}
	if tokens.RefreshTokenExpiresIn <= 0 {
		session.RefreshExpires = now.Add(sessionTTL)
	}
	if err := oauth.saveSession(request.Context(), session); err != nil {
		writeError(response, http.StatusServiceUnavailable, "failed to create session")
		return
	}
	oauth.setSessionCookies(response, session)
	http.Redirect(response, request, "/", http.StatusFound)
}

func (oauth *githubOAuth) logout(response http.ResponseWriter, request *http.Request) {
	session, ok := oauth.loadRequestSession(request)
	if ok {
		_ = oauth.revoke(request.Context(), session.AccessToken)
		_ = oauth.revoke(request.Context(), session.RefreshToken)
		_ = oauth.deleteSession(request.Context(), session.ID)
	}
	oauth.clearSessionCookies(response)
	response.WriteHeader(http.StatusNoContent)
}

func (oauth *githubOAuth) session(response http.ResponseWriter, request *http.Request) (oauthSession, bool) {
	session, ok := oauth.loadRequestSession(request)
	if !ok {
		return oauthSession{}, false
	}
	if time.Now().UTC().Add(tokenRefreshSkew).Before(session.AccessExpires) {
		return session, true
	}
	if session.RefreshToken == "" || time.Now().UTC().After(session.RefreshExpires) {
		_ = oauth.deleteSession(request.Context(), session.ID)
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
		_ = oauth.deleteSession(request.Context(), session.ID)
		oauth.clearSessionCookies(response)
		return oauthSession{}, false
	}
	now := time.Now().UTC()
	session.AccessToken = refreshed.AccessToken
	if refreshed.RefreshToken != "" {
		session.RefreshToken = refreshed.RefreshToken
	}
	session.AccessExpires = now.Add(time.Duration(refreshed.ExpiresIn) * time.Second)
	if refreshed.RefreshTokenExpiresIn > 0 {
		session.RefreshExpires = now.Add(time.Duration(refreshed.RefreshTokenExpiresIn) * time.Second)
	}
	if refreshed.ExpiresIn <= 0 {
		session.AccessExpires = now.Add(time.Hour)
	}
	if err := oauth.saveSession(request.Context(), session); err != nil {
		return oauthSession{}, false
	}
	return session, true
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
		return tokenResponse{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := oauth.client.Do(request) // #nosec G704 -- see endpoint validation note above.
	if err != nil {
		return tokenResponse{}, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return tokenResponse{}, errors.New("GitHub OAuth token endpoint rejected the request")
	}
	var tokens tokenResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&tokens); err != nil {
		return tokenResponse{}, err
	}
	if tokens.Error != "" || tokens.AccessToken == "" {
		return tokenResponse{}, errors.New("GitHub OAuth token endpoint did not return an access token")
	}
	return tokens, nil
}

func (oauth *githubOAuth) authorizedLogin(ctx context.Context, accessToken string) (string, error) {
	login, err := oauth.githubLogin(ctx, accessToken)
	if err != nil {
		return "", err
	}
	for _, org := range oauth.config.AllowedOrganizations {
		if oauth.orgAuthorized(ctx, accessToken, org) {
			return login, nil
		}
	}
	for _, team := range oauth.config.AllowedTeams {
		parts := strings.Split(team, "/")
		if len(parts) == 2 && oauth.teamAuthorized(ctx, accessToken, parts[0], parts[1], login) {
			return login, nil
		}
	}
	return "", errors.New("GitHub user is not authorized")
}

func (oauth *githubOAuth) githubLogin(ctx context.Context, accessToken string) (string, error) {
	var payload struct {
		Login string `json:"login"`
	}
	if err := oauth.githubJSON(ctx, http.MethodGet, oauth.config.UserURL, accessToken, nil, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.Login) == "" {
		return "", errors.New("GitHub user response did not include a login")
	}
	return payload.Login, nil
}

func (oauth *githubOAuth) orgAuthorized(ctx context.Context, accessToken, org string) bool {
	var payload struct {
		State string `json:"state"`
	}
	endpoint := strings.ReplaceAll(oauth.config.OrgMembershipURL, "{org}", url.PathEscape(org))
	return oauth.githubJSON(ctx, http.MethodGet, endpoint, accessToken, nil, &payload) == nil && payload.State == "active"
}

func (oauth *githubOAuth) teamAuthorized(ctx context.Context, accessToken, org, team, login string) bool {
	var payload struct {
		State string `json:"state"`
	}
	endpoint := strings.ReplaceAll(oauth.config.TeamMembershipURL, "{org}", url.PathEscape(org))
	endpoint = strings.ReplaceAll(endpoint, "{team}", url.PathEscape(team))
	endpoint = strings.ReplaceAll(endpoint, "{user}", url.PathEscape(login))
	return oauth.githubJSON(ctx, http.MethodGet, endpoint, accessToken, nil, &payload) == nil && payload.State == "active"
}

func (oauth *githubOAuth) revoke(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]string{"access_token": token})
	endpoint := strings.ReplaceAll(oauth.config.RevokeURL, "{client_id}", url.PathEscape(oauth.config.ClientID))
	return oauth.githubJSON(ctx, http.MethodDelete, endpoint, "", bytes.NewReader(body), nil)
}

func (oauth *githubOAuth) githubJSON(ctx context.Context, method, endpoint, token string, body io.Reader, output any) error {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
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
	response, err := oauth.client.Do(request)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
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
	value, err := oauth.configStore(ctx, "GET", oauth.sessionKey(sessionID))
	if err != nil || value == nil {
		return oauthSession{}, errors.New("session is unavailable")
	}
	plain, err := oauth.open(fmt.Sprint(value))
	if err != nil {
		return oauthSession{}, err
	}
	var session oauthSession
	if err := json.Unmarshal(plain, &session); err != nil {
		return oauthSession{}, err
	}
	return session, nil
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
	return base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, plain, nil)), nil
}

func (oauth *githubOAuth) open(sealed string) ([]byte, error) {
	data, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(oauth.key)
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

func randomToken(bytes int) (string, error) {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
