package cli

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

type deployAzurePermission struct {
	Actions    []string `json:"actions"`
	NotActions []string `json:"notActions"`
}

func deployAzureActionMatches(pattern, action string) bool {
	expression := regexp.QuoteMeta(strings.ToLower(pattern))
	expression = strings.ReplaceAll(expression, `\*`, ".*")
	matched, _ := regexp.MatchString("^"+expression+"$", strings.ToLower(action))
	return matched
}

func deployAzureActionAllowed(permissions []deployAzurePermission, action string) bool {
	for _, permission := range permissions {
		allowed := slices.ContainsFunc(permission.Actions, func(pattern string) bool { return deployAzureActionMatches(pattern, action) })
		excluded := slices.ContainsFunc(permission.NotActions, func(pattern string) bool { return deployAzureActionMatches(pattern, action) })
		if allowed && !excluded {
			return true
		}
	}
	return false
}

func (p *deployAzurePreflight) checkPermissions(ctx context.Context) deployAzureCheck {
	const id = "permissions"
	if check := p.skipped(id); check != nil {
		return *check
	}
	scope := p.targetScope()
	remediation := "Grant the deploying identity resource creation, ACR build and job execution permissions plus Microsoft.Authorization/roleAssignments/write at " + scope + "; activate any required PIM assignment, then rerun preflight."
	var response struct {
		Value    []deployAzurePermission `json:"value"`
		NextLink string                  `json:"nextLink"`
	}
	if err := p.runJSON(ctx, &response, "rest", "--method", "get", "--url", scope+"/providers/Microsoft.Authorization/permissions?api-version=2022-04-01", "--output", "json"); err != nil {
		return deployAzureCheckResult(id, deployAzureCheckUnknown, "could not read ARM effective permissions: "+azError(err), remediation)
	}
	if response.Value == nil || response.NextLink != "" {
		return deployAzureCheckResult(id, deployAzureCheckUnknown, "ARM effective permissions were missing or incomplete (pagination); authority could not be verified", remediation)
	}
	required := []string{
		"Microsoft.Resources/deployments/write",
		"Microsoft.Authorization/roleAssignments/write",
		"Microsoft.ContainerRegistry/registries/scheduleRun/action",
		"Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action",
		"Microsoft.App/jobs/start/action",
	}
	if !p.groupExists {
		required = append(required, "Microsoft.Resources/subscriptions/resourceGroups/write")
	}
	for _, resourceType := range p.template.types {
		required = append(required, resourceType+"/write")
	}
	var missing []string
	for _, action := range required {
		if !deployAzureActionAllowed(response.Value, action) {
			missing = append(missing, action)
		}
	}
	if len(missing) != 0 {
		slices.Sort(missing)
		missing = slices.Compact(missing)
		return deployAzureCheckResult(id, deployAzureCheckFail, fmt.Sprintf("ARM effective permissions at %s do not grant: %s", scope, strings.Join(missing, ", ")), remediation)
	}
	return deployAzureCheckResult(id, deployAzureCheckPass, "can create resources and role assignments, build images and execute jobs at "+scope+" (ARM effective permissions; no Microsoft Graph lookup)", "")
}
