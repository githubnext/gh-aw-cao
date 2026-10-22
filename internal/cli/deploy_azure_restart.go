package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/internal/azcli"
)

const (
	deployAzureReferenceTimeout = 10 * time.Minute
	deployAzureReferencePause   = 10 * time.Second
)

// deployAzureRestartAndAwaitReferences restarts the Function App once after
// its managed-identity grants and database provisioning exist, because App
// Service resolves Key Vault references at site start and keeps a denied
// result until restart. It then waits until every Key Vault reference reports
// Resolved, reporting only setting names and statuses.
func deployAzureRestartAndAwaitReferences(ctx context.Context, deps deployAzureDeps, az azcli.Executor, config deployAzureConfig) error {
	scope := []string{"--subscription", config.Subscription, "--resource-group", config.ResourceGroup, "--name", config.Resources.FunctionApp}
	if _, err := az.Run(ctx, append([]string{"functionapp", "restart"}, scope...)...); err != nil {
		return fmt.Errorf("restart Function App to re-resolve Key Vault references: %s", azError(err))
	}
	ctx, cancel := context.WithTimeout(ctx, deployAzureReferenceTimeout)
	defer cancel()
	url := "/subscriptions/" + config.Subscription + "/resourceGroups/" + config.ResourceGroup +
		"/providers/Microsoft.Web/sites/" + config.Resources.FunctionApp + "/config/configreferences/appsettings?api-version=2023-12-01"
	var last string
	for {
		result, err := az.Run(ctx, "rest", "--method", "get", "--url", url, "--output", "json")
		switch {
		case err != nil:
			last = "could not read Key Vault reference status: " + azError(err)
		default:
			pending, parseErr := deployAzureUnresolvedReferences(result.Stdout)
			if parseErr != nil {
				last = parseErr.Error()
			} else if len(pending) == 0 {
				return nil
			} else {
				last = "unresolved Key Vault references: " + strings.Join(pending, ", ")
			}
		}
		if err := deployAzurePause(ctx, deps, deployAzureReferencePause); err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("the Function App's Key Vault references did not resolve within %s after restart (%s); verify the Function App identity's Key Vault Secrets User grant", deployAzureReferenceTimeout, last)
			}
			return fmt.Errorf("waiting for Function App Key Vault references: %w", err)
		}
	}
}

// deployAzureUnresolvedReferences returns "NAME=status" for every reference
// that is not Resolved. Reference targets and values are never returned.
func deployAzureUnresolvedReferences(body string) ([]string, error) {
	var response struct {
		Value []struct {
			Name       string `json:"name"`
			Properties struct {
				Status string `json:"status"`
			} `json:"properties"`
		} `json:"value"`
	}
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		return nil, errors.New("could not parse Key Vault reference status")
	}
	if len(response.Value) == 0 {
		return nil, errors.New("no Key Vault references reported yet")
	}
	var pending []string
	for _, reference := range response.Value {
		name := reference.Name
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		if reference.Properties.Status != "Resolved" {
			status := reference.Properties.Status
			if status == "" {
				status = "Unknown"
			}
			pending = append(pending, name+"="+status)
		}
	}
	slices.Sort(pending)
	return pending, nil
}
