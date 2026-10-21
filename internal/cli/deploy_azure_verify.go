package cli

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

	"github.com/githubnext/gh-cao/internal/azcli"
)

type deployAzureVerification struct {
	Check     string `json:"check"`
	Status    int    `json:"status"`
	Passed    bool   `json:"passed"`
	CheckedAt string `json:"checkedAt"`
}

func deployAzureVerify(ctx context.Context, deps deployAzureDeps, az azcli.Executor, config deployAzureConfig, host string) ([]deployAzureVerification, error) {
	client := http.Client{Timeout: 15 * time.Second}
	if deps.http != nil {
		client = *deps.http
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var checks []deployAzureVerification
	for _, check := range []struct {
		name, host, path string
		status           int
	}{
		{"health", host, "/api/health", 200},
		{"readiness", host, "/api/readiness", 200},
		{"signed-out-campaigns", host, "/api/v1/campaigns", 401},
		{"root-login", host, "/", 302},
		{"github-oauth", host, "/auth/login", 302},
		{"scm-denied", config.Resources.FunctionApp + ".scm.azurewebsites.net", "/", 403},
	} {
		passed := false
		var lastError error
		for attempt := 0; attempt < 60; attempt++ {
			requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, "https://"+check.host+check.path, nil)
			if err != nil {
				cancel()
				return checks, err
			}
			response, err := client.Do(request)
			if err != nil {
				cancel()
				// Do not expose transport errors that could contain redirect state.
				lastError = fmt.Errorf("%s: HTTPS request failed", check.name)
			} else {
				body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
				_ = response.Body.Close()
				cancel()
				if response.StatusCode == http.StatusForbidden && check.host == host {
					return checks, deployAzureCheckIngress(ctx, az, config)
				}
				lastError = fmt.Errorf("%s returned HTTP %d, want %d", check.name, response.StatusCode, check.status)
				if response.StatusCode != check.status && (check.name == "health" || check.name == "readiness") {
					lastError = fmt.Errorf("%w (%s)", lastError, deployAzureHealthSignals(body))
				}
				if response.StatusCode == check.status {
					switch check.name {
					case "root-login":
						redirect, err := url.Parse(response.Header.Get("Location"))
						passed = err == nil && redirect.Path == "/auth/login" &&
							(redirect.Host == "" || (redirect.Scheme == "https" && redirect.Host == host)) && redirect.User == nil
					case "github-oauth":
						redirect, err := url.Parse(response.Header.Get("Location"))
						passed = err == nil && redirect.Scheme == "https" && redirect.Host == "github.com" && redirect.Path == "/login/oauth/authorize" &&
							redirect.User == nil && redirect.Query().Get("client_id") == config.OAuth.ClientID &&
							redirect.Query().Get("redirect_uri") == "https://"+host+"/auth/callback"
					default:
						passed = true
					}
					if !passed {
						lastError = fmt.Errorf("%s returned an unexpected authentication redirect", check.name)
					}
				}
				if passed {
					checks = append(checks, deployAzureVerification{Check: check.name, Status: response.StatusCode, Passed: true, CheckedAt: deps.now().UTC().Format(time.RFC3339)})
					break
				}
			}
			if err := deployAzurePause(ctx, deps, 5*time.Second); err != nil {
				return checks, fmt.Errorf("verification cancelled after %v: %w", lastError, err)
			}
		}
		if !passed {
			return checks, fmt.Errorf("deployment verification failed after bounded retries: %w", lastError)
		}
	}
	return checks, nil
}

func deployAzureCheckIngress(ctx context.Context, az azcli.Executor, config deployAzureConfig) error {
	scope := []string{"--subscription", config.Subscription, "--resource-group", config.ResourceGroup, "--name", config.Resources.FunctionApp}
	app, err := az.Run(ctx, append([]string{"functionapp", "show"}, append(scope, "--query", "{publicNetworkAccess:publicNetworkAccess}", "--output", "json")...)...)
	if err != nil {
		return fmt.Errorf("main site returned 403; could not read ingress: %w", err)
	}
	var access struct {
		PublicNetworkAccess string `json:"publicNetworkAccess"`
	}
	if err := json.Unmarshal([]byte(app.Stdout), &access); err != nil {
		return fmt.Errorf("main site returned 403; parse ingress read-back: %w", err)
	}
	rules, err := az.Run(ctx, append([]string{"webapp", "config", "access-restriction", "show"}, append(scope, "--output", "json")...)...)
	if err != nil {
		return fmt.Errorf("main site returned 403; could not read access restrictions: %w", err)
	}
	var restrictions struct {
		DefaultAction string `json:"ipSecurityRestrictionsDefaultAction"`
		Rules         []struct {
			Action    string `json:"action"`
			IPAddress string `json:"ipAddress"`
			Name      string `json:"name"`
			Priority  int    `json:"priority"`
		} `json:"ipSecurityRestrictions"`
	}
	if err := json.Unmarshal([]byte(rules.Stdout), &restrictions); err != nil {
		return fmt.Errorf("main site returned 403; parse access restrictions: %w", err)
	}
	custom := 0
	for _, rule := range restrictions.Rules {
		if !strings.EqualFold(rule.Action, "Allow") || rule.IPAddress != "Any" || rule.Priority != 2147483647 {
			custom++
		}
	}
	if !strings.EqualFold(access.PublicNetworkAccess, "Enabled") || restrictions.DefaultAction != "Allow" || custom != 0 {
		return fmt.Errorf("ingress was changed outside this deployment (possible tenant policy/remediator): publicNetworkAccess=%s, main default action=%s, explicit rules=%d; no ingress changes were attempted",
			access.PublicNetworkAccess, restrictions.DefaultAction, custom)
	}
	return errors.New("main site returned HTTP 403 although read-back is public Enabled/Allow with no custom rules; investigate Azure ingress; no ingress changes were attempted")
}

// deployAzureHealthSignals summarizes only the boolean, signed-out health
// fields so a failed verification is actionable without echoing the body.
func deployAzureHealthSignals(body []byte) string {
	var payload struct {
		Redis *struct {
			Connected bool `json:"connected"`
		} `json:"redis"`
		Data *struct {
			Available bool `json:"available"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Redis == nil || payload.Data == nil {
		return "response is not CAO health JSON; the Function App container may not have started, check its image pull and startup logs"
	}
	switch {
	case !payload.Redis.Connected:
		return "CAO reports its operational cache is disconnected"
	case !payload.Data.Available:
		return "CAO is running but reports dashboard data unavailable; check PostgreSQL runtime access and the ingestion job"
	default:
		return "CAO reports cache connected and data available"
	}
}
