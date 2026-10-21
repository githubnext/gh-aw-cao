package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/internal/azcli"
)

type deployAzureARMError struct {
	Code    string                `json:"code"`
	Message string                `json:"message"`
	Target  string                `json:"target"`
	Details []deployAzureARMError `json:"details"`
}

func deployAzureSecretPropagationFailure(stderr string, config deployAzureConfig, deployment string) bool {
	start := strings.IndexByte(stderr, '{')
	if start < 0 {
		return false
	}
	var envelope struct {
		Status string               `json:"status"`
		Error  *deployAzureARMError `json:"error"`
	}
	if _, err := nativeDecodeJSON([]byte(stderr[start:])); err != nil {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(stderr[start:]))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || envelope.Error == nil ||
		envelope.Error.Code != "DeploymentFailed" || len(envelope.Error.Details) == 0 ||
		(envelope.Status != "" && envelope.Status != "Failed") {
		return false
	}
	scope := strings.ToLower("/subscriptions/" + config.Subscription + "/resourceGroups/" + config.ResourceGroup + "/providers/")
	deployments := scope + "microsoft.resources/deployments/"
	jobs := scope + "microsoft.app/jobs/" + config.Resources.FunctionApp
	var visit func(deployAzureARMError, string, int) bool
	visit = func(failure deployAzureARMError, module string, depth int) bool {
		if depth > 32 {
			return false
		}
		switch strings.ToLower(failure.Target) {
		case "":
		case deployments + deployment:
			if module != "" {
				return false
			}
		case deployments + "snapshot-ingestion":
			if module != "" && module != "snapshot-ingestion" {
				return false
			}
			module = "snapshot-ingestion"
		case deployments + "database-provisioning":
			if module != "" && module != "database-provisioning" {
				return false
			}
			module = "database-provisioning"
		case jobs + "-ingest":
			if module != "snapshot-ingestion" {
				return false
			}
		case jobs + "-db-provision":
			if module != "database-provisioning" {
				return false
			}
		default:
			return false
		}
		if len(failure.Details) > 0 {
			if failure.Code != "DeploymentFailed" && failure.Code != "ResourceDeploymentFailure" {
				return false
			}
			for _, child := range failure.Details {
				if !visit(child, module, depth+1) {
					return false
				}
			}
			return true
		}
		message := strings.ToLower(failure.Message)
		for _, code := range []string{"authorizationfailed", "requestdisallowedbypolicy", "forbiddenbypolicy", "deniedbypolicy"} {
			if strings.Contains(message, code) {
				return false
			}
		}
		suffix := "-ingest-identity"
		if module == "database-provisioning" {
			suffix = "-db-provision-identity"
		}
		identity := scope + "microsoft.managedidentity/userassignedidentities/" + config.Resources.FunctionApp + suffix
		return module != "" && failure.Code == "InvalidParameterValueInContainerTemplate" &&
			strings.Contains(message, "configuration.secrets") &&
			strings.Contains(message, "unable to get value using managed identity") &&
			strings.Contains(message, "unable to fetch secret") && strings.Contains(message, identity)
	}
	return visit(*envelope.Error, "", 0)
}

func deployAzureCreateTemplate(ctx context.Context, deps deployAzureDeps, az azcli.Executor, config deployAzureConfig, deployment, template, parameters string) (azcli.Result, error) {
	if err := ctx.Err(); err != nil {
		return azcli.Result{}, err
	}
	request := []string{"deployment", "group", "create", "--subscription", config.Subscription,
		"--resource-group", config.ResourceGroup, "--name", deployment, "--template-file", template,
		"--parameters", "@" + parameters, "--output", "json"}
	runAttempt := func() (azcli.Result, error) {
		attemptCtx, cancel := context.WithTimeout(ctx, 45*time.Minute)
		defer cancel()
		result, failure := az.Run(attemptCtx, request...)
		if attemptCtx.Err() == nil && !errors.Is(failure, context.Canceled) && !errors.Is(failure, context.DeadlineExceeded) {
			return result, failure
		}
		failure = errors.Join(failure, attemptCtx.Err())
		cancelCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancelCleanup()
		_, cancelErr := az.Run(cancelCtx, "deployment", "group", "cancel", "--subscription", config.Subscription,
			"--resource-group", config.ResourceGroup, "--name", deployment, "--output", "none")
		if cancelErr != nil {
			return result, errors.Join(failure, fmt.Errorf("explicit ARM cancellation failed; deployment may still be running: %w", cancelErr))
		}
		if deps.diagnostics != nil {
			if _, err := fmt.Fprintln(deps.diagnostics, "ARM deployment timed out or was cancelled; the explicit cancellation request for this exact deployment was accepted."); err != nil {
				return result, errors.Join(failure, fmt.Errorf("write ARM cancellation diagnostic: %w", err))
			}
		}
		return result, failure
	}
	result, failure := runAttempt()
	if failure == nil {
		return result, nil
	}
	for retry := 1; retry <= 3; retry++ {
		if errors.Is(failure, context.Canceled) || errors.Is(failure, context.DeadlineExceeded) ||
			!deployAzureSecretPropagationFailure(result.Stderr, config, deployment) {
			return result, failure
		}
		if err := ctx.Err(); err != nil {
			return result, errors.Join(failure, err)
		}
		delay := time.Duration(retry) * 30 * time.Second
		if deps.diagnostics != nil {
			if _, err := fmt.Fprintf(deps.diagnostics, "Managed-identity Key Vault job secret resolution is propagating; retry %d/3 in %s using the same reviewed deployment.\n", retry, delay); err != nil {
				return result, errors.Join(failure, fmt.Errorf("write deployment retry diagnostic: %w", err))
			}
		}
		if err := deployAzurePause(ctx, deps, delay); err != nil {
			return result, errors.Join(failure, fmt.Errorf("wait for job secret access: %w", err))
		}
		previousFailure := failure
		result, failure = runAttempt()
		if failure == nil {
			return result, nil
		}
		if errors.Is(failure, context.Canceled) || errors.Is(failure, context.DeadlineExceeded) {
			return result, errors.Join(failure, fmt.Errorf("preceding managed-identity secret propagation failure: %w", previousFailure))
		}
	}
	return result, fmt.Errorf("deployment failed after three bounded managed-identity secret propagation retries: %w", failure)
}
