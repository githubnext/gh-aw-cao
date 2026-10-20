package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/internal/azcli"
)

func testAzureRetryConfig() deployAzureConfig {
	return deployAzureConfig{
		Subscription: testDeploySubscription, ResourceGroup: "rg-synthetic-test",
		Resources: deployAzureResources{FunctionApp: "fa-synthetic-test"},
	}
}

func testAzureRetryFailure(config deployAzureConfig, deployment string, modules ...string) deployAzureARMError {
	scope := "/subscriptions/" + config.Subscription + "/resourceGroups/" + config.ResourceGroup + "/providers/"
	root := deployAzureARMError{Code: "DeploymentFailed", Target: scope + "Microsoft.Resources/deployments/" + deployment}
	for _, module := range modules {
		suffix := "-ingest-identity"
		if module == "database-provisioning" {
			suffix = "-db-provision-identity"
		}
		identity := scope + "Microsoft.ManagedIdentity/userAssignedIdentities/" + config.Resources.FunctionApp + suffix
		root.Details = append(root.Details, deployAzureARMError{
			Code: "ResourceDeploymentFailure", Target: scope + "Microsoft.Resources/deployments/" + module,
			Details: []deployAzureARMError{{Code: "DeploymentFailed", Details: []deployAzureARMError{{
				Code:    "InvalidParameterValueInContainerTemplate",
				Message: fmt.Sprintf("Field 'configuration.secrets' is invalid: Unable to get value using Managed identity %s for secret cao-postgres-url. Error: unable to fetch secret 'cao-postgres-url' using Managed identity '%s'", identity, identity),
			}}}},
		})
	}
	return root
}

func testAzureRetryJSON(t *testing.T, failure deployAzureARMError) string {
	t.Helper()
	content, err := json.Marshal(map[string]any{"status": "Failed", "error": failure})
	if err != nil {
		t.Fatal(err)
	}
	return "ERROR: " + string(content)
}

func TestDeployAzureSecretRetryFailsClosedOnEveryErrorBranch(t *testing.T) {
	config := testAzureRetryConfig()
	tests := []struct {
		name   string
		change func(*deployAzureARMError)
	}{
		{"missing details", func(f *deployAzureARMError) { f.Details = nil }},
		{"authorization wrapper", func(f *deployAzureARMError) { f.Code = "AuthorizationFailed" }},
		{"authorization leaf", func(f *deployAzureARMError) { f.Details[0].Details[0].Details[0].Code = "AuthorizationFailed" }},
		{"mixed error leaves", func(f *deployAzureARMError) {
			f.Details = append(f.Details, deployAzureARMError{Code: "ContainerAppInvalidName", Message: "invalid job name"})
		}},
		{"unrelated module", func(f *deployAzureARMError) { f.Details[0].Target += "-unrelated" }},
		{"unrelated resource", func(f *deployAzureARMError) {
			f.Details[0].Details[0].Details[0].Target = "/subscriptions/" + config.Subscription + "/resourceGroups/another-group/providers/Microsoft.App/jobs/other"
		}},
		{"unrelated managed identity", func(f *deployAzureARMError) {
			leaf := &f.Details[0].Details[0].Details[0]
			leaf.Message = strings.ReplaceAll(leaf.Message, config.Resources.FunctionApp+"-ingest-identity", "unrelated-identity")
		}},
		{"explicit policy failure", func(f *deployAzureARMError) {
			f.Details[0].Details[0].Details[0].Message += " RequestDisallowedByPolicy"
		}},
		{"unrecognized secret error", func(f *deployAzureARMError) {
			f.Details[0].Details[0].Details[0].Message = "configuration.secrets is invalid"
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			failure := testAzureRetryFailure(config, "cao-test", "snapshot-ingestion", "database-provisioning")
			tt.change(&failure)
			if deployAzureSecretPropagationFailure(testAzureRetryJSON(t, failure), config, "cao-test") {
				t.Fatal("unrecognized or mixed failure was admitted for retry")
			}
		})
	}
	valid := testAzureRetryJSON(t, testAzureRetryFailure(config, "cao-test", "snapshot-ingestion", "database-provisioning"))
	if !deployAzureSecretPropagationFailure(valid, config, "cao-test") {
		t.Fatal("both recognized job modules must be retryable")
	}
	for _, malformed := range []string{
		"", `ERROR: {"error":`, `{"error":{"code":"DeploymentFailed","details":"invalid"}}`,
		valid + "\nnot JSON",
		strings.Replace(valid, `"status":"Failed"`, `"status":"Failed","status":"Succeeded"`, 1),
		strings.Replace(valid, `"status":"Failed"`, `"additionalInfo":[{"code":"AuthorizationFailed"}],"status":"Failed"`, 1),
	} {
		if deployAzureSecretPropagationFailure(malformed, config, "cao-test") {
			t.Fatalf("malformed or unknown error fields were retried: %s", malformed)
		}
	}
}

func TestDeployAzureSecretRetryReusesExactReviewedRequest(t *testing.T) {
	config := testAzureRetryConfig()
	directory := t.TempDir()
	template, parameters := filepath.Join(directory, "template.json"), filepath.Join(directory, "parameters.json")
	writeTestFile(t, template, `{"template":"reviewed"}`)
	writeTestFile(t, parameters, `{"password":{"value":"`+testDeploySession+`"}}`)
	transient := testAzureRetryJSON(t, testAzureRetryFailure(config, "cao-test", "snapshot-ingestion", "database-provisioning"))
	var calls [][]string
	az := azcli.ExecutorFunc(func(ctx context.Context, args ...string) (azcli.Result, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 45*time.Minute {
			t.Fatal("deployment subprocess is not bounded")
		}
		calls = append(calls, slices.Clone(args))
		for _, secret := range testDeploySecrets() {
			if strings.Contains(strings.Join(args, " "), secret) {
				t.Fatal("secret in deployment retry argv")
			}
		}
		content, err := os.ReadFile(parameters)
		if err != nil || string(content) != `{"password":{"value":"`+testDeploySession+`"}}` {
			t.Fatal("resolved parameters changed between requests")
		}
		content, err = os.ReadFile(template)
		if err != nil || string(content) != `{"template":"reviewed"}` {
			t.Fatal("reviewed template changed between requests")
		}
		if len(calls) == 1 {
			return azcli.Result{Stderr: transient}, errors.New("original secret propagation detail")
		}
		if time.Until(deadline) < 10*time.Minute {
			t.Fatal("a simulated ten-minute ARM replay must fit within the same 45-minute attempt bound")
		}
		return azcli.Result{Stdout: `{"succeeded":true}`}, nil
	})
	var diagnostics bytes.Buffer
	pauses := 0
	deps := deployAzureDeps{
		diagnostics: &diagnostics,
		pause: func(ctx context.Context, delay time.Duration) error {
			pauses++
			if delay != 30*time.Second {
				t.Fatalf("unexpected backoff: %s", delay)
			}
			return ctx.Err()
		},
	}
	result, err := deployAzureCreateTemplate(context.Background(), deps, az, config, "cao-test", template, parameters)
	if err != nil || result.Stdout != `{"succeeded":true}` || len(calls) != 2 || pauses != 1 {
		t.Fatalf("recognized failure did not recover: calls=%d pauses=%d result=%+v err=%v", len(calls), pauses, result, err)
	}
	if !slices.Equal(calls[0], calls[1]) {
		t.Fatalf("retry changed the reviewed request: %q vs %q", calls[0], calls[1])
	}
	if !strings.Contains(diagnostics.String(), "retry 1/3") || strings.Contains(diagnostics.String(), "original secret propagation detail") {
		t.Fatalf("missing or unsanitized retry diagnostic: %s", &diagnostics)
	}
	for _, secret := range testDeploySecrets() {
		if strings.Contains(diagnostics.String(), secret) {
			t.Fatal("retry diagnostic contains a secret")
		}
	}
}

func TestDeployAzureSecretRetryPreservesShorterCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	config := testAzureRetryConfig()
	transient := testAzureRetryJSON(t, testAzureRetryFailure(config, "cao-test", "snapshot-ingestion"))
	calls := 0
	deps := deployAzureDeps{pause: func(ctx context.Context, _ time.Duration) error {
		if actual, ok := ctx.Deadline(); !ok || !actual.Equal(deadline) {
			t.Fatal("retry backoff extended the caller deadline")
		}
		return ctx.Err()
	}}
	az := azcli.ExecutorFunc(func(ctx context.Context, _ ...string) (azcli.Result, error) {
		calls++
		if actual, ok := ctx.Deadline(); !ok || !actual.Equal(deadline) {
			t.Fatal("deployment subprocess extended the caller deadline")
		}
		if calls == 1 {
			return azcli.Result{Stderr: transient}, errors.New("secret propagation")
		}
		return azcli.Result{Stdout: `{}`}, nil
	})
	if _, err := deployAzureCreateTemplate(ctx, deps, az, config, "cao-test", "template.json", "parameters.json"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("deployment calls=%d, want 2", calls)
	}
}

func TestDeployAzureSecretRetryExhaustionAndCancellation(t *testing.T) {
	config := testAzureRetryConfig()
	transient := testAzureRetryJSON(t, testAzureRetryFailure(config, "cao-test", "snapshot-ingestion"))
	for _, mode := range []string{"exhaustion", "cancel-backoff", "cancel-command", "cancel-retry", "unrecognized-error"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls, pauses, cancellations := 0, 0, 0
			deps := deployAzureDeps{pause: func(ctx context.Context, _ time.Duration) error {
				pauses++
				if mode == "cancel-backoff" {
					cancel()
				}
				return ctx.Err()
			}}
			az := azcli.ExecutorFunc(func(ctx context.Context, args ...string) (azcli.Result, error) {
				if azcli.CommandName(args) == "deployment group cancel" {
					cancellations++
					if ctx.Err() != nil {
						t.Fatal("ARM cancellation reused a cancelled context")
					}
					if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 2*time.Minute {
						t.Fatal("ARM cancellation is not bounded")
					}
					return azcli.Result{}, nil
				}
				calls++
				stderr := transient
				failure := errors.New("terminal detail must survive")
				if mode == "cancel-command" || (mode == "cancel-retry" && calls == 2) {
					failure = context.DeadlineExceeded
				}
				if mode == "unrecognized-error" {
					stderr = `ERROR: {"error":{"code":"AuthorizationFailed"}}`
				}
				return azcli.Result{Stderr: stderr}, failure
			})
			_, err := deployAzureCreateTemplate(ctx, deps, az, config, "cao-test", "template.json", "parameters.json")
			if err == nil {
				t.Fatal("terminal deployment failure was hidden")
			}
			wantCalls, wantPauses := 1, 0
			switch mode {
			case "exhaustion":
				wantCalls, wantPauses = 4, 3
				if !strings.Contains(err.Error(), "three bounded") || !strings.Contains(err.Error(), "terminal detail must survive") {
					t.Fatalf("retry exhaustion lost terminal detail: %v", err)
				}
			case "cancel-backoff":
				wantPauses = 1
				if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "terminal detail must survive") {
					t.Fatalf("cancellation lost context or terminal detail: %v", err)
				}
			case "cancel-command":
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("subprocess deadline was hidden: %v", err)
				}
			case "cancel-retry":
				wantCalls, wantPauses = 2, 1
				if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "terminal detail must survive") {
					t.Fatalf("retry deadline lost context or preceding failure detail: %v", err)
				}
			}
			if calls != wantCalls || pauses != wantPauses {
				t.Fatalf("calls=%d pauses=%d, want %d/%d", calls, pauses, wantCalls, wantPauses)
			}
			wantCancellations := 0
			if mode == "cancel-command" || mode == "cancel-retry" {
				wantCancellations = 1
			}
			if cancellations != wantCancellations {
				t.Fatalf("ARM cancellations=%d, want %d", cancellations, wantCancellations)
			}
		})
	}
}

func TestDeployAzureAttemptDeadlineExplicitlyCancelsExactARMDeployment(t *testing.T) {
	for _, mode := range []string{"initial-timeout", "replay-timeout", "cancel-fails"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			config := testAzureRetryConfig()
			transient := testAzureRetryJSON(t, testAzureRetryFailure(config, "cao-test", "snapshot-ingestion"))
			var calls []string
			var diagnostics bytes.Buffer
			deps := deployAzureDeps{
				diagnostics: &diagnostics,
				pause:       func(ctx context.Context, _ time.Duration) error { return ctx.Err() },
			}
			az := azcli.ExecutorFunc(func(attemptCtx context.Context, args ...string) (azcli.Result, error) {
				verb := azcli.CommandName(args)
				calls = append(calls, verb)
				if verb == "deployment group create" {
					if mode == "replay-timeout" && len(calls) == 1 {
						return azcli.Result{Stderr: transient}, errors.New("preceding propagation detail")
					}
					<-attemptCtx.Done()
					return azcli.Result{}, attemptCtx.Err()
				}
				want := []string{"deployment", "group", "cancel", "--subscription", config.Subscription,
					"--resource-group", config.ResourceGroup, "--name", "cao-test", "--output", "none"}
				if !slices.Equal(args, want) {
					t.Fatalf("cancellation changed deployment identity: %q", args)
				}
				if attemptCtx.Err() != nil || ctx.Err() == nil {
					t.Fatal("cancellation must remain executable after the deployment deadline")
				}
				if deadline, ok := attemptCtx.Deadline(); !ok || time.Until(deadline) > 2*time.Minute {
					t.Fatal("ARM cancellation has no bounded independent deadline")
				}
				if mode == "cancel-fails" {
					return azcli.Result{}, errors.New("cancel permission denied")
				}
				return azcli.Result{}, nil
			})
			_, err := deployAzureCreateTemplate(ctx, deps, az, config, "cao-test", "template.json", "parameters.json")
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("attempt timeout did not fail closed: %v", err)
			}
			want := []string{"deployment group create", "deployment group cancel"}
			if mode == "replay-timeout" {
				want = []string{"deployment group create", "deployment group create", "deployment group cancel"}
				if !strings.Contains(err.Error(), "preceding propagation detail") {
					t.Fatalf("interrupted replay lost preceding detail: %v", err)
				}
			}
			if !slices.Equal(calls, want) {
				t.Fatalf("unexpected requests after timeout: %q", calls)
			}
			if mode == "cancel-fails" {
				if !strings.Contains(err.Error(), "explicit ARM cancellation failed") || !strings.Contains(err.Error(), "cancel permission denied") {
					t.Fatalf("ARM cancellation failure was hidden: %v", err)
				}
			} else if !strings.Contains(diagnostics.String(), "explicit cancellation request") {
				t.Fatal("accepted ARM cancellation was not reported")
			}
		})
	}
}

func TestDeployAzureApplyRecoversSecretPropagationWithoutReAdmission(t *testing.T) {
	fake, deps, config, plan, options := testAzureApplySetup(t)
	fake.transientARMFailures = 1
	var diagnostics bytes.Buffer
	deps.diagnostics = &diagnostics
	if err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options); err != nil {
		t.Fatal(err)
	}
	var deployments [][]string
	builds := 0
	for _, args := range fake.calls {
		switch azcli.CommandName(args) {
		case "acr build":
			builds++
		case "deployment group create":
			index := slices.Index(args, "--name")
			if !strings.HasSuffix(args[index+1], "-registry") {
				deployments = append(deployments, args)
			}
		case "group exists", "deployment group what-if", "deployment sub what-if":
			if len(deployments) > 0 {
				t.Fatal("fresh-only admission ran again after starting the deployment")
			}
		}
	}
	if builds != 3 || len(deployments) != 2 || !slices.Equal(deployments[0], deployments[1]) || fake.httpCalls != 6 {
		t.Fatalf("retry changed build/deploy/verify ordering: builds=%d deployments=%q http=%d", builds, deployments, fake.httpCalls)
	}
	if !strings.Contains(diagnostics.String(), "retry 1/3") {
		t.Fatal("transient recovery did not surface its bounded retry")
	}
}

func TestDeployAzureJobPrefixLengthAndGrammarBeforeAzureCalls(t *testing.T) {
	for _, name := range []string{strings.Repeat("a", 20), "a--b", "Uppercase", "1starts-with-digit"} {
		t.Run(name, func(t *testing.T) {
			config := testDeployConfig()
			config["resources"].(map[string]any)["functionApp"] = name
			fake := &fakeAz{t: t}
			root, _, _ := testDeployRoot(fake)
			root.SetArgs([]string{"deploy", "azure", "--plan", "--config", writeDeployConfig(t, config), "--template", testDeployTemplatePath(t), "--out", filepath.Join(t.TempDir(), "plan.json")})
			if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "resources.functionApp") {
				t.Fatalf("invalid derived job name was not rejected: %v", err)
			}
			if len(fake.calls) != 0 {
				t.Fatalf("invalid job prefix reached Azure: %q", fake.calls)
			}
		})
	}
	config := testDeployConfig()
	config["resources"].(map[string]any)["functionApp"] = strings.Repeat("a", 19)
	if _, err := loadDeployAzureConfig(writeDeployConfig(t, config)); err != nil {
		t.Fatalf("19-character job prefix must fit the 32-character provisioning boundary: %v", err)
	}
}
