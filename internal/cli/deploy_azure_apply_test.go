package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/internal/azcli"
)

type testAzureBuildSource struct{}

func (testAzureBuildSource) Materialize(_ context.Context, directory string) (string, error) {
	if err := os.WriteFile(filepath.Join(directory, "product.json"), []byte(`{"product":true}`), 0o600); err != nil {
		return "", err
	}
	return strings.Repeat("a", 40), nil
}

type testAzureTransport func(*http.Request) (*http.Response, error)

func (f testAzureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type fakeAzureApply struct {
	t                    *testing.T
	plan                 *fakeAz
	calls                [][]string
	failBuild            bool
	buildRunID           bool
	failJob              bool
	concurrent           bool
	httpCalls            int
	polls                int
	transientARMFailures int
	deploymentOutputs    map[string]any
}

func (f *fakeAzureApply) Run(ctx context.Context, args ...string) (azcli.Result, error) {
	f.t.Helper()
	f.calls = append(f.calls, slices.Clone(args))
	for _, secret := range testDeploySecrets() {
		if strings.Contains(strings.Join(args, " "), secret) {
			f.t.Fatal("secret in Azure argv")
		}
	}
	if azcli.IsReadOnly(args) {
		return f.plan.Run(ctx, args...)
	}
	flag := func(name string) string {
		i := slices.Index(args, name)
		if i < 0 || i+1 == len(args) {
			return ""
		}
		return args[i+1]
	}
	switch azcli.CommandName(args) {
	case "group create", "acr repository update":
		return azcli.Result{}, nil
	case "acr build":
		if f.failBuild {
			if f.buildRunID {
				return azcli.Result{}, fmt.Errorf("the run with ID 'ds1' failed %s", testDeployClientSecret)
			}
			return azcli.Result{}, fmt.Errorf("build failed %s", testDeployClientSecret)
		}
		if flag("--target") == "" || flag("--platform") != "linux/amd64" {
			f.t.Fatal("ACR build missing target or platform")
		}
		context := args[len(args)-1]
		if _, err := os.Stat(filepath.Join(context, ".github", "workflows", "cao.azure.json")); err != nil {
			f.t.Fatal("operator policy was not layered into build context")
		}
		return azcli.Result{Stdout: `{}`}, nil
	case "acr task logs":
		return azcli.Result{Stdout: "source build diagnostic: required COPY input missing " + testDeploySession}, nil
	case "acr repository show":
		return azcli.Result{Stdout: `{"digest":"sha256:` + strings.Repeat("b", 64) + `"}`}, nil
	case "deployment group create":
		content, err := os.ReadFile(flag("--template-file"))
		if err != nil {
			f.t.Fatal(err)
		}
		if strings.HasSuffix(flag("--name"), "-registry") {
			var template struct {
				Resources []struct {
					SKU struct{ Name string } `json:"sku"`
				} `json:"resources"`
			}
			if err := json.Unmarshal(content, &template); err != nil || len(template.Resources) != 1 || template.Resources[0].SKU.Name != "Basic" {
				f.t.Fatalf("registry must match exact template SKU: %s", content)
			}
			return azcli.Result{Stdout: `{}`}, nil
		}
		parameters, err := os.ReadFile(strings.TrimPrefix(flag("--parameters"), "@"))
		if err != nil {
			f.t.Fatal(err)
		}
		for _, secret := range testDeploySecrets() {
			if !strings.Contains(string(parameters), secret) {
				f.t.Fatal("secure value not passed by file")
			}
		}
		if f.transientARMFailures > 0 {
			f.transientARMFailures--
			failure := testAzureRetryFailure(testAzureRetryConfig(), flag("--name"), "snapshot-ingestion", "database-provisioning")
			return azcli.Result{Stderr: testAzureRetryJSON(f.t, failure)}, fmt.Errorf("managed identity propagation: %s", testDeployClientSecret)
		}
		outputs := map[string]any{
			"functionHostName":    map[string]any{"value": "fa-synthetic-test.azurewebsites.net"},
			"ingestionJobName":    map[string]any{"value": "fa-synthetic-test-ingest"},
			"provisioningJobName": map[string]any{"value": "fa-synthetic-test-db-provision"},
			"collectionEnabled":   map[string]any{"type": "Bool", "value": false},
			"retentionDays":       map[string]any{"type": "Int", "value": 45},
			"unrelatedObject":     map[string]any{"type": "Object", "value": map[string]any{"enabled": true}},
			"unrelatedArray":      map[string]any{"type": "Array", "value": []string{"synthetic"}},
		}
		for name, value := range f.deploymentOutputs {
			outputs[name] = map[string]any{"value": value}
		}
		result, err := json.Marshal(map[string]any{
			"id":         "/subscriptions/" + testDeploySubscription + "/resourceGroups/rg-synthetic-test/providers/Microsoft.Resources/deployments/cao-test",
			"properties": map[string]any{"provisioningState": "Succeeded", "outputs": outputs},
		})
		if err != nil {
			f.t.Fatal(err)
		}
		return azcli.Result{Stdout: string(result)}, nil
	case "containerapp job execution list":
		if f.concurrent {
			return azcli.Result{Stdout: `[{"name":"fa-synthetic-test-ingest-other","properties":{"status":"Running"}}]`}, nil
		}
		return azcli.Result{Stdout: `[]`}, nil
	case "containerapp job start":
		return azcli.Result{Stdout: fmt.Sprintf(`{"name":%q}`, flag("--name")+"-exact")}, nil
	case "containerapp job execution show":
		if flag("--job-execution-name") != flag("--name")+"-exact" {
			f.t.Fatal("did not wait on exact started execution")
		}
		f.polls++
		status := "Succeeded"
		if f.polls%2 == 1 {
			status = "Running"
		}
		if f.failJob {
			status = "Failed"
		}
		return azcli.Result{Stdout: fmt.Sprintf(`{"name":%q,"properties":{"status":%q}}`, flag("--job-execution-name"), status)}, nil
	case "containerapp job replica list":
		return azcli.Result{Stdout: `[{"name":"replica","properties":{"initContainers":[{"name":"bootstrap-canonical","runningState":"Terminated","runningStateDetails":"bootstrap permission denied"}]}}]`}, nil
	case "functionapp show":
		return azcli.Result{Stdout: `{"publicNetworkAccess":"Disabled"}`}, nil
	case "webapp config access-restriction show":
		return azcli.Result{Stdout: `{"ipSecurityRestrictionsDefaultAction":"Deny","ipSecurityRestrictions":[]}`}, nil
	default:
		f.t.Fatalf("unexpected Azure command: %q", args)
		return azcli.Result{}, nil
	}
}

func testAzureApplySetup(t *testing.T) (*fakeAzureApply, deployAzureDeps, string, string, deployAzureApplyOptions) {
	t.Helper()
	fake := &fakeAzureApply{t: t, plan: &fakeAz{t: t}}
	deps := deployAzureDeps{
		az: fake, getenv: testDeployEnv, now: func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) },
		template: func(path string) deployAzureTemplateSource { return deployAzureFileTemplate{path: path} },
		source:   func(string) deployAzureBuildSource { return testAzureBuildSource{} },
		pause:    func(ctx context.Context, _ time.Duration) error { return ctx.Err() },
		http: &http.Client{Transport: testAzureTransport(func(request *http.Request) (*http.Response, error) {
			fake.httpCalls++
			status := 200
			header := http.Header{}
			switch request.URL.Path {
			case "/api/v1/campaigns":
				status = 401
			case "/":
				status = 302
				header.Set("Location", "/auth/login")
				if strings.Contains(request.URL.Host, ".scm.") {
					status = 403
				}
			case "/auth/login":
				status = 302
				header.Set("Location", "https://github.com/login/oauth/authorize?client_id=Iv1.synthetic0001&redirect_uri="+url.QueryEscape("https://fa-synthetic-test.azurewebsites.net/auth/callback"))
			}
			return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
		})},
	}
	configPath := writeDeployConfig(t, testDeployConfig())
	planPath := filepath.Join(t.TempDir(), "reviewed-plan.json")
	if err := deployAzurePlanRun(context.Background(), io.Discard, deps, configPath, testDeployTemplatePath(t), planPath); err != nil {
		t.Fatal(err)
	}
	fake.calls = nil
	repo := t.TempDir()
	writeTestFile(t, filepath.Join(repo, ".github", "workflows", "cao.json"), `{"version":1,"gh-aw-version":"v0.92.6","control-plane":{"campaigns":{}}}`)
	writeTestFile(t, filepath.Join(repo, ".github", "workflows", "cao.azure.json"), `{"extends":"cao.json","control-plane":{"web":{"host":{"target":{"module":"azure-functions"},"operational-store":{"backend":"postgres"}}}}}`)
	return fake, deps, configPath, planPath, deployAzureApplyOptions{
		SourceDir: "development-source", RepoDir: repo, EmptyEvidence: true, ReceiptPath: filepath.Join(t.TempDir(), "receipt.json"),
	}
}

func TestDeployAzureApplyHappyPathExactOrderingWithHeterogeneousOutputs(t *testing.T) {
	fake, deps, config, plan, options := testAzureApplySetup(t)
	if err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options); err != nil {
		t.Fatal(err)
	}
	var writes []string
	for _, call := range fake.calls {
		if !azcli.IsReadOnly(call) {
			writes = append(writes, azcli.CommandName(call))
		}
	}
	want := []string{"group create", "deployment group create",
		"acr build", "acr repository show", "acr repository update",
		"acr build", "acr repository show", "acr repository update",
		"acr build", "acr repository show", "acr repository update",
		"deployment group create", "containerapp job execution list", "containerapp job start",
		"containerapp job execution show", "containerapp job execution show",
		"containerapp job execution list", "containerapp job start",
		"containerapp job execution show", "containerapp job execution show"}
	if !slices.Equal(writes, want) {
		t.Fatalf("apply verb ordering = %q, want %q", writes, want)
	}
	if fake.httpCalls != 6 {
		t.Fatalf("verification requests = %d, want 6", fake.httpCalls)
	}
	content, err := os.ReadFile(options.ReceiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt deployAzureReceipt
	if err := json.Unmarshal(content, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.PlanSHA256 == "" || receipt.JobExecution != "fa-synthetic-test-ingest-exact" || receipt.ProvisionExecution != "fa-synthetic-test-db-provision-exact" || len(receipt.Images) != 3 || len(receipt.Verification) != 6 || receipt.DeploymentID == "" {
		t.Fatalf("incomplete receipt: %+v", receipt)
	}
	for _, secret := range testDeploySecrets() {
		if strings.Contains(string(content), secret) {
			t.Fatal("receipt contains secret")
		}
	}
	for _, image := range receipt.Images {
		if image.Tag == "latest" || !strings.Contains(image.Reference, "@sha256:") {
			t.Fatalf("image not immutable: %+v", image)
		}
	}
}

func TestDeployAzureApplyRejectsInvalidRequiredOutputs(t *testing.T) {
	for _, tt := range []struct {
		name, output, want string
		value              any
	}{
		{"hostname-type", "functionHostName", "parse deployment result", false},
		{"ingestion-type", "ingestionJobName", "parse deployment result", 45},
		{"provision-type", "provisioningJobName", "parse deployment result", []string{"untrusted"}},
		{"hostname-null", "functionHostName", "unexpected Function App hostname", nil},
		{"ingestion-name", "ingestionJobName", "unexpected Function App hostname or ingestion job", "untrusted-ingest"},
		{"provision-name", "provisioningJobName", "unexpected database provision job", "untrusted-provision"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fake, deps, config, plan, options := testAzureApplySetup(t)
			fake.deploymentOutputs = map[string]any{tt.output: tt.value}
			err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want %q, got %v", tt.want, err)
			}
			for _, call := range fake.calls {
				if azcli.CommandName(call) == "containerapp job start" {
					t.Fatal("job executed after invalid deployment output")
				}
			}
			if fake.httpCalls != 0 {
				t.Fatal("verification proceeded after invalid deployment output")
			}
			if _, err := os.Stat(options.ReceiptPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid output wrote a success receipt: %v", err)
			}
		})
	}
}

func TestDeployAzureApplyStopsOnFailures(t *testing.T) {
	for _, tt := range []struct {
		name, want string
		change     func(*fakeAzureApply)
	}{
		{"drift", "plan drift", func(fake *fakeAzureApply) { fake.plan.whatIf = `{"status":"Succeeded","changes":[]}` }},
		{"build", "ACR build target", func(fake *fakeAzureApply) { fake.failBuild = true }},
		{"bootstrap", "init/bootstrap container bootstrap-canonical", func(fake *fakeAzureApply) { fake.failJob = true }},
		{"concurrent", "concurrent ingestion execution", func(fake *fakeAzureApply) { fake.concurrent = true }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fake, deps, config, plan, options := testAzureApplySetup(t)
			tt.change(fake)
			err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want %q, got %v", tt.want, err)
			}
			for _, secret := range testDeploySecrets() {
				if strings.Contains(err.Error(), secret) {
					t.Fatal("secret in error output")
				}
			}
			if fake.httpCalls != 0 {
				t.Fatal("verification proceeded after failed prerequisite")
			}
			for _, call := range fake.calls {
				switch tt.name {
				case "drift":
					if !azcli.IsReadOnly(call) {
						t.Fatalf("Azure write after drift: %q", call)
					}
				case "build":
					if azcli.CommandName(call) == "deployment group create" && !strings.Contains(strings.Join(call, " "), "-registry") {
						t.Fatal("full template deployment proceeded after build failure")
					}
				case "concurrent":
					if azcli.CommandName(call) == "containerapp job start" {
						t.Fatal("started job despite concurrent execution")
					}
				}
			}
			if _, err := os.Stat(options.ReceiptPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("failure wrote a success receipt: %v", err)
			}
		})
	}
}

func TestDeployAzureApplyEvidenceIsExplicit(t *testing.T) {
	for _, both := range []bool{false, true} {
		fake, deps, config, plan, options := testAzureApplySetup(t)
		options.EmptyEvidence = both
		if both {
			options.SnapshotDir = "snapshot"
		}
		err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options)
		if err == nil || !strings.Contains(err.Error(), "exactly one") || len(fake.calls) != 0 {
			t.Fatalf("ambiguous evidence must fail before Azure: %v", err)
		}
	}
}

func TestDeployAzureVerifyIngressRemediator(t *testing.T) {
	fake, deps, configPath, _, _ := testAzureApplySetup(t)
	config, err := loadDeployAzureConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	deps.http = &http.Client{Transport: testAzureTransport(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	_, err = deployAzureVerify(context.Background(), deps, fake, config.config, "fa-synthetic-test.azurewebsites.net")
	if err == nil || !strings.Contains(err.Error(), "ingress was changed outside this deployment (possible tenant policy/remediator)") {
		t.Fatalf("missing distinct ingress diagnostic: %v", err)
	}
}

func TestDeployAzureBuildAllowlist(t *testing.T) {
	for _, name := range []string{".env", ".git/config", ".github/workflows/cao.json", ".github/workflows/cao.azure.json", "unrelated/secret.txt", "server/.env", "dashboard/site/node_modules/a.js", "../escape.go", "server/internal/testdata/fixture.json", "server/internal/server/.env", "dashboard/site/src/signing.pem", "dashboard/site/src/cao.json", "internal/dashboardquery/query_test.go", "activity/inventory.mjs"} {
		if deployAzureBuildFileAllowed(name) {
			t.Fatalf("unsafe build input allowed: %s", name)
		}
	}
	for _, name := range []string{"server/Dockerfile", "server/go.mod", "server/azure/empty-data/gh-aw-logs-runs/empty.jsonl", "dashboard/site/package-lock.json", "dashboard/site/manifest.webmanifest", "internal/dashboardquery/query.go", ".github/workflows/shared/policy.mjs", "activity/actions-log.mjs", "server/azure/provision.sh"} {
		if !deployAzureBuildFileAllowed(name) {
			t.Fatalf("required build input excluded: %s", name)
		}
	}
}

func TestDeployAzureSnapshotHashAndAllowlist(t *testing.T) {
	source := filepath.Join("..", "..", "server", "azure", "empty-data")
	destination := filepath.Join(t.TempDir(), "snapshot")
	if err := copyDeployAzureSnapshot(source, destination); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(destination, "gh-aw-logs-runs", "empty.jsonl"), "corrupt")
	if err := copyDeployAzureSnapshot(destination, filepath.Join(t.TempDir(), "copy")); err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("corrupt snapshot admitted: %v", err)
	}
}

func TestDeployAzureVerifyRejectsWrongOAuthClientAndCallback(t *testing.T) {
	for _, redirect := range []string{
		"https://github.com/login/oauth/authorize?client_id=wrong&redirect_uri=https%3A%2F%2Ffa-synthetic-test.azurewebsites.net%2Fauth%2Fcallback",
		"https://github.com/login/oauth/authorize?client_id=Iv1.synthetic0001&redirect_uri=https%3A%2F%2Fother.example.test%2Fauth%2Fcallback",
		"https://github.com.evil.example.test/login/oauth/authorize?client_id=Iv1.synthetic0001",
	} {
		fake, deps, configPath, _, _ := testAzureApplySetup(t)
		config, err := loadDeployAzureConfig(configPath)
		if err != nil {
			t.Fatal(err)
		}
		original := deps.http.Transport
		requests := 0
		deps.http.Transport = testAzureTransport(func(request *http.Request) (*http.Response, error) {
			requests++
			response, err := original.RoundTrip(request)
			if err == nil && request.URL.Path == "/auth/login" {
				response.Header.Set("Location", redirect)
			}
			return response, err
		})
		_, err = deployAzureVerify(context.Background(), deps, fake, config.config, config.config.Resources.FunctionApp+".azurewebsites.net")
		if err == nil || !strings.Contains(err.Error(), "unexpected authentication redirect") || requests != 64 {
			t.Fatalf("unsafe redirect was accepted or retries were not bounded: requests=%d err=%v", requests, err)
		}
	}
}

func TestDeployAzureJobWaitCancellation(t *testing.T) {
	fake, deps, configPath, _, _ := testAzureApplySetup(t)
	config, err := loadDeployAzureConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	deps.pause = func(context.Context, time.Duration) error { return context.DeadlineExceeded }
	execution, err := deployAzureRunJob(context.Background(), deps, fake, config.config, "fa-synthetic-test-ingest")
	if execution != "fa-synthetic-test-ingest-exact" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("job wait did not preserve execution or deadline: %s %v", execution, err)
	}
}

func TestDeployAzureConfigPurgeProtectionAndTag(t *testing.T) {
	content, err := json.Marshal(testDeployConfig())
	if err != nil {
		t.Fatal(err)
	}

	config, err := parseDeployAzureConfig(content)
	if err != nil {
		t.Fatal(err)
	}
	if _, supplied := config.parameters()["keyVaultPurgeProtection"]; supplied {
		t.Fatal("omitted purge protection must preserve the template default")
	}
	protect := false
	config.KeyVault.PurgeProtection = &protect
	if config.parameters()["keyVaultPurgeProtection"] != false {
		t.Fatal("explicit disposable opt-out was not bound")
	}
	tag := deployAzureImageTag(config)
	config.RetentionDays++
	if tag == deployAzureImageTag(config) || !strings.HasPrefix(tag, config.Image.Tag+"-") {
		t.Fatal("immutable tag does not include reviewed version and configuration identity")
	}
}

func TestDeployAzurePostgresNameCheckUsesSupportedAPIVersion(t *testing.T) {
	content, err := os.ReadFile(testDeployTemplatePath(t))
	if err != nil {
		t.Fatal(err)
	}

	preflight := deployAzurePreflight{
		config:   deployAzureConfig{Subscription: testDeploySubscription, Location: "westus3"},
		template: deployAzureTemplateFactsFrom(content),
	}
	args := preflight.restNameArgs("Microsoft.DBforPostgreSQL", "Microsoft.DBforPostgreSQL/flexibleServers", "synthetic-test-pg")
	if !strings.Contains(strings.Join(args, " "), "/locations/westus3/checkNameAvailability?api-version=2024-08-01") {
		t.Fatalf("name-check must use the actual PostgreSQL resource API version, got %q", args)
	}
}

func TestDeployAzureBuildFailureRetainsRedactedDiagnostics(t *testing.T) {
	fake, deps, config, plan, options := testAzureApplySetup(t)
	fake.failBuild, fake.buildRunID = true, true
	err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options)
	if err == nil || !strings.Contains(err.Error(), "required COPY input missing") || !strings.Contains(err.Error(), "ACR build ds1 log tail") {
		t.Fatalf("failed build did not retain diagnostics: %v", err)
	}

	for _, secret := range testDeploySecrets() {
		if strings.Contains(err.Error(), secret) {
			t.Fatal("build diagnostics contain a secret")
		}
	}
	if fake.httpCalls != 0 {
		t.Fatal("verification proceeded after build failure")
	}
}

func TestDeployAzureInvalidAdopterPolicyAbortsBeforeWrites(t *testing.T) {
	fake, deps, config, plan, options := testAzureApplySetup(t)
	writeTestFile(t, filepath.Join(options.RepoDir, ".github", "workflows", "cao.json"), `{"version":1,"control-plane":{"campaigns":{}}}`)
	err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options)
	if err == nil || !strings.Contains(err.Error(), "gh-aw-version is required") {
		t.Fatalf("invalid operator policy was not rejected: %v", err)
	}
	for _, args := range fake.calls {
		if !azcli.IsReadOnly(args) {
			t.Fatalf("invalid operator policy caused Azure write: %q", args)
		}
	}
}

func TestDeployAzureBuildMetadataSeparatesTagsFromSemanticVersions(t *testing.T) {
	revision := strings.Repeat("a", 40)
	for _, tag := range []string{"v1.2.3", "1.2.3-preview.1", "u7-dev", revision} {
		version := deployAzureBuildVersion(tag, revision)
		if !nativeExactVersion.MatchString("v" + strings.TrimPrefix(version, "v")) {
			t.Fatalf("image tag %s produced invalid dashboard version %s", tag, version)
		}
		if tag == "u7-dev" || tag == revision {
			if version != "0.0.0-main."+revision {
				t.Fatalf("non-semver tag lost its explicit source revision: %s", version)
			}
		} else if version != tag {
			t.Fatalf("reviewed release version changed: %s", version)
		}
	}
}
