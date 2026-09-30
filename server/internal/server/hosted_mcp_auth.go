package server

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

const (
	actionsOIDCIssuer  = "https://token.actions.githubusercontent.com"
	actionsOIDCJWKS    = actionsOIDCIssuer + "/.well-known/jwks"
	actionsMCPAudience = "https://cao.githubnext.com/mcp"
)

func (a *App) authorizeHostedMCP(request *http.Request) bool {
	if !a.config.MCPEnabled || a.config.HostProfile.Name != "coolify" ||
		a.config.HostProfile.Authentication != HostAuthenticationOAuth {
		return false
	}
	oidc := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	token := request.Header.Get("X-GitHub-Actions-Token")
	if oidc == "" || oidc == request.Header.Get("Authorization") || token == "" {
		return false
	}
	claims, err := verifyActionsOIDC(request.Context(), oidc, a.config.ActionsHTTPClient)
	if err != nil || claims["iss"] != actionsOIDCIssuer ||
		!claims.VerifyAudience(actionsMCPAudience, true) ||
		claims["repository"] != a.config.ActionsRepository ||
		claims["repository_id"] != a.config.HostedMCPRepositoryID ||
		claims["workflow_ref"] != a.config.ActionsRepository+"/.github/workflows/cao-remote-mcp-explorer.lock.yml@refs/heads/main" ||
		!nonemptyOIDCClaim(claims, "event_name") ||
		!nonemptyOIDCClaim(claims, "run_id") ||
		!claims.VerifyIssuedAt(time.Now().Unix(), true) ||
		!claims.VerifyExpiresAt(time.Now().Unix(), true) {
		return false
	}

	return verifyGitHubActionsPermissions(request.Context(), a.config, token) == nil
}

func nonemptyOIDCClaim(claims jwt.MapClaims, name string) bool {
	value, ok := claims[name].(string)
	return ok && value != ""
}

func verifyActionsOIDC(ctx context.Context, raw string, client *http.Client) (jwt.MapClaims, error) {
	if len(raw) > 8192 {
		return nil, errors.New("OIDC token is too large")
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	claims := jwt.MapClaims{}
	parsed, err := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()})).ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		kid, ok := token.Header["kid"].(string)
		if !ok || kid == "" {
			return nil, errors.New("OIDC key ID is missing")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, actionsOIDCJWKS, nil)
		if err != nil {
			return nil, err
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != http.StatusOK || res.Request.URL.String() != actionsOIDCJWKS {
			return nil, errors.New("OIDC key set is unavailable")
		}
		var keys struct {
			Keys []struct {
				Kid string `json:"kid"`
				Kty string `json:"kty"`
				Alg string `json:"alg"`
				Use string `json:"use"`
				N   string `json:"n"`
				E   string `json:"e"`
			} `json:"keys"`
		}
		if err := json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&keys); err != nil {
			return nil, err
		}
		for _, key := range keys.Keys {
			if key.Kid != kid || key.Kty != "RSA" || key.Alg != "RS256" || key.Use != "sig" {
				continue
			}
			n, errN := base64.RawURLEncoding.DecodeString(key.N)
			e, errE := base64.RawURLEncoding.DecodeString(key.E)
			if errN != nil || errE != nil || len(n) < 256 || len(n) > 1024 || len(e) == 0 || len(e) > 4 {
				break
			}
			exponent := new(big.Int).SetBytes(e)
			if exponent.Int64() < 3 || !exponent.IsInt64() || exponent.Bit(0) == 0 {
				break
			}
			return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent.Int64())}, nil
		}
		return nil, errors.New("OIDC signing key is not trusted")
	})
	if err != nil || !parsed.Valid {
		return nil, errors.New("OIDC assertion is invalid")
	}
	return claims, nil
}
