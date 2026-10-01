package server

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	actionsOIDCIssuer   = "https://token.actions.githubusercontent.com"
	actionsOIDCAudience = "https://cao.githubnext.com"
	actionsOIDCJWKS     = actionsOIDCIssuer + "/.well-known/jwks"
)

type actionsOIDCClaims struct {
	Issuer     string          `json:"iss"`
	Audience   json.RawMessage `json:"aud"`
	Repository string          `json:"repository"`
	Subject    string          `json:"sub"`
	Ref        string          `json:"ref"`
	Actor      string          `json:"actor"`
	IssuedAt   int64           `json:"iat"`
	NotBefore  int64           `json:"nbf"`
	ExpiresAt  int64           `json:"exp"`
}

func verifyHostedActionsMCP(ctx context.Context, config Config, request *http.Request) (string, error) {
	token, ok := bearerToken(request)
	provenance := request.Header.Get("X-GitHub-OIDC-Token")
	if !ok || token == "" || provenance == "" {
		return "", errors.New("Actions token and OIDC provenance are required")
	}
	claims, err := verifyActionsOIDC(ctx, config, provenance)
	if err != nil {
		return "", err
	}
	if err := verifyActionsTokenRepository(ctx, config, token); err != nil {
		return "", err
	}
	defaultBranch, err := actionsDefaultBranch(ctx, config, token)
	if err != nil {
		return "", err
	}
	repository := strings.TrimSpace(config.ActionsRepository)
	ref := "refs/heads/" + defaultBranch
	if claims.Ref != ref || !strings.EqualFold(claims.Subject, "repo:"+repository+":ref:"+ref) {
		return "", errors.New("GitHub Actions OIDC provenance does not match the repository default branch")
	}
	if err := verifyGitHubActionsPermissions(ctx, config, token); err != nil {
		return "", err
	}
	return strings.ToLower(claims.Actor), nil
}

func actionsDefaultBranch(ctx context.Context, config Config, token string) (string, error) {
	owner, name, err := parseActionsRepository(config.ActionsRepository)
	if err != nil {
		return "", err
	}
	baseURL, err := resolveGitHubAPIBaseURL(config.GitHubAPIURL)
	if err != nil {
		return "", err
	}
	client := config.ActionsHTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		baseURL+"/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name), nil)
	if err != nil {
		return "", errors.New("GitHub Actions default branch check could not be created")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "gh-aw-cao-mcp")
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("GitHub Actions default branch check failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("GitHub Actions default branch is unavailable")
	}
	var repository struct {
		DefaultBranch string `json:"default_branch"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&repository) != nil ||
		repository.DefaultBranch == "" || len(repository.DefaultBranch) > 255 ||
		strings.IndexFunc(repository.DefaultBranch, func(r rune) bool { return r <= ' ' || r == '\x7f' }) >= 0 {
		return "", errors.New("GitHub Actions default branch is invalid")
	}
	return repository.DefaultBranch, nil
}

// The installation endpoint requires an authenticated installation token,
// unlike read endpoints that may serve public repositories anonymously.
func verifyActionsTokenRepository(ctx context.Context, config Config, token string) error {
	baseURL, err := resolveGitHubAPIBaseURL(config.GitHubAPIURL)
	if err != nil {
		return err
	}
	client := config.ActionsHTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		baseURL+"/installation/repositories?per_page=100", nil)
	if err != nil {
		return errors.New("GitHub Actions token identity check could not be created")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "gh-aw-cao-mcp")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("GitHub Actions token identity check failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("GitHub Actions token is not an authorized installation token")
	}
	var accessible struct {
		Repositories []struct {
			FullName string `json:"full_name"`
		} `json:"repositories"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&accessible) != nil {
		return errors.New("GitHub Actions token repository list is invalid")
	}
	owner, name, err := parseActionsRepository(config.ActionsRepository)
	if err != nil {
		return err
	}
	expected := owner + "/" + name
	for _, repository := range accessible.Repositories {
		if strings.EqualFold(repository.FullName, expected) {
			return nil
		}
	}
	return errors.New("GitHub Actions token cannot access the configured repository")
}

func verifyActionsOIDC(ctx context.Context, config Config, token string) (actionsOIDCClaims, error) {
	invalid := errors.New("invalid GitHub Actions OIDC provenance")
	if len(token) > 8192 {
		return actionsOIDCClaims{}, invalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return actionsOIDCClaims{}, invalid
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(headerBytes) > 1024 {
		return actionsOIDCClaims{}, invalid
	}
	var header struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
		Type      string `json:"typ"`
	}
	if json.Unmarshal(headerBytes, &header) != nil || header.Algorithm != "RS256" ||
		header.KeyID == "" || len(header.KeyID) > 256 {
		return actionsOIDCClaims{}, invalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) > 8192 {
		return actionsOIDCClaims{}, invalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) == 0 {
		return actionsOIDCClaims{}, invalid
	}
	key, err := fetchActionsOIDCKey(ctx, config.ActionsHTTPClient, header.KeyID)
	if err != nil {
		return actionsOIDCClaims{}, invalid
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature) != nil {
		return actionsOIDCClaims{}, invalid
	}
	var claims actionsOIDCClaims
	if json.Unmarshal(payload, &claims) != nil {
		return actionsOIDCClaims{}, invalid
	}
	var audience string
	if json.Unmarshal(claims.Audience, &audience) != nil {
		var audiences []string
		if json.Unmarshal(claims.Audience, &audiences) != nil || len(audiences) != 1 {
			return actionsOIDCClaims{}, invalid
		}
		audience = audiences[0]
	}
	now := time.Now().Unix()
	repository := strings.TrimSpace(config.ActionsRepository)
	if claims.Issuer != actionsOIDCIssuer || audience != actionsOIDCAudience ||
		!strings.EqualFold(claims.Repository, repository) ||
		claims.Actor == "" || len(claims.Actor) > 100 ||
		strings.IndexFunc(claims.Actor, func(r rune) bool { return r <= ' ' || r == '\x7f' }) >= 0 ||
		claims.IssuedAt <= 0 || claims.IssuedAt > now+30 ||
		claims.ExpiresAt <= now || claims.ExpiresAt-claims.IssuedAt > 600 ||
		claims.NotBefore > now+30 {
		return actionsOIDCClaims{}, invalid
	}
	return claims, nil
}

func fetchActionsOIDCKey(ctx context.Context, client *http.Client, keyID string) (*rsa.PublicKey, error) {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, actionsOIDCJWKS, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("Actions OIDC JWKS is unavailable")
	}
	var jwks struct {
		Keys []struct {
			ID       string `json:"kid"`
			Type     string `json:"kty"`
			Use      string `json:"use"`
			Alg      string `json:"alg"`
			Modulus  string `json:"n"`
			Exponent string `json:"e"`
		} `json:"keys"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 64<<10))
	if decoder.Decode(&jwks) != nil || len(jwks.Keys) > 32 {
		return nil, errors.New("invalid Actions OIDC JWKS")
	}
	for _, key := range jwks.Keys {
		if key.ID != keyID || key.Type != "RSA" || key.Use != "sig" ||
			(key.Alg != "" && key.Alg != "RS256") {
			continue
		}
		n, nErr := base64.RawURLEncoding.DecodeString(key.Modulus)
		e, eErr := base64.RawURLEncoding.DecodeString(key.Exponent)
		if nErr != nil || eErr != nil || len(n) < 256 || len(n) > 512 || len(e) == 0 || len(e) > 4 {
			return nil, errors.New("invalid Actions OIDC key")
		}
		exponent := new(big.Int).SetBytes(e)
		if !exponent.IsInt64() || exponent.Int64() < 3 || exponent.Int64()%2 == 0 ||
			exponent.Int64() > 1<<31-1 {
			return nil, errors.New("invalid Actions OIDC exponent")
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent.Int64())}, nil
	}
	return nil, errors.New("Actions OIDC signing key is unknown")
}
