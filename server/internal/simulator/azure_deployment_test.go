package simulator

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func azureSetupParameters(args []string) (map[string]json.RawMessage, error) {
	path := strings.TrimPrefix(azureFlag(args, "--parameters"), "@")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("Azure parameters must use an owner-only regular file")
	}
	content, err := os.ReadFile(path) // #nosec G304 -- CLI-created owner-only parameter file within the isolated test workspace.
	if err != nil {
		return nil, fmt.Errorf("read Azure parameter file: %w", err)
	}
	var document struct {
		Parameters map[string]json.RawMessage `json:"parameters"`
	}
	if err := json.Unmarshal(content, &document); err != nil {
		return nil, fmt.Errorf("invalid Azure parameter document")
	}
	if document.Parameters["postgresAdministratorPassword"] != nil {
		for field, variable := range map[string]string{ // #nosec G101 -- environment variable names, never credential values.
			"postgresAdministratorPassword": "CAO_SIM_POSTGRES_PASSWORD", "postgresOwnerPassword": "CAO_SIM_OWNER_PASSWORD",
			"postgresRuntimePassword": "CAO_SIM_RUNTIME_PASSWORD", "githubClientSecret": "CAO_SIM_CLIENT_SECRET", "sessionSecret": "CAO_SIM_SESSION_SECRET",
		} {
			var parameter struct{ Value string }
			if err := json.Unmarshal(document.Parameters[field], &parameter); err != nil || parameter.Value != setupAzureSecrets()[variable] {
				return nil, fmt.Errorf("secure parameters were not delivered through the parameter file")
			}
		}
	}
	return document.Parameters, nil
}

func (a *azureSetupAPI) apply(r *http.Request, command string, args []string) (any, error) {
	switch command {
	case "group create":
		if a.group || azureFlag(args, "--name") != setupAzureGroup {
			return nil, fmt.Errorf("resource group must be fresh and exact")
		}
		a.group = true
		return map[string]any{}, nil
	case "deployment group create":
		return a.deploy(r, args)
	case "acr build":
		if !a.registry || azureFlag(args, "--registry") != setupAzureRegistry || azureFlag(args, "--platform") != "linux/amd64" {
			return nil, fmt.Errorf("build requires the deployed registry and expected platform")
		}
		image := azureFlag(args, "--image")
		repository, _, ok := strings.Cut(image, ":")
		target := map[string]string{"cao-functions": "azure-functions-runtime", "cao-ingest": "azure-empty-ingest-runtime", "cao-db-provision": "azure-db-provision"}[repository]
		if repository == "cao-ingest" && a.snapshot {
			target = "azure-ingest-runtime"
		}
		if !ok || target == "" || azureFlag(args, "--target") != target || a.images[image] != "" {
			return nil, fmt.Errorf("unexpected or repeated image build")
		}
		directory := args[len(args)-1]
		source, err := os.OpenRoot(directory)
		if err != nil {
			return nil, fmt.Errorf("open build context: %w", err)
		}
		defer func() { _ = source.Close() }()
		if target == "azure-functions-runtime" && a.functions != nil {
			if err := a.functions.build(directory); err != nil {
				return nil, err
			}
		}
		for _, name := range []string{"server/Dockerfile", ".github/workflows/cao.json", ".github/workflows/cao.azure.json"} {
			if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
				return nil, fmt.Errorf("build context is missing a required product or policy input")
			}
		}
		for _, name := range []string{"consumer.txt", ".env", ".git/config"} {
			if _, err := os.Lstat(filepath.Join(directory, name)); !os.IsNotExist(err) {
				return nil, fmt.Errorf("build context contains a consumer-owned or credential file")
			}
		}
		contextHash := sha256.New()
		err = filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			name, err := filepath.Rel(directory, path)
			if err != nil {
				return err
			}
			content, err := source.ReadFile(name)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(contextHash, "%s:%x\n", filepath.ToSlash(name), sha256.Sum256(content))
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("read build context: %w", err)
		}
		manifest, err := json.Marshal(map[string]string{"target": target, "contextSha256": fmt.Sprintf("%x", contextHash.Sum(nil))})
		if err != nil {
			return nil, err
		}
		if _, err := a.storage.request(r.Context(), http.MethodPut, "/setup/"+repository+".json", manifest); err != nil {
			return nil, fmt.Errorf("persist simulated ACR source upload: %w", err)
		}
		a.images[image] = fmt.Sprintf("sha256:%x", sha256.Sum256(manifest))
		return map[string]any{}, nil
	case "acr repository show", "acr repository update":
		image := azureFlag(args, "--image")
		digest := a.images[image]
		if digest == "" {
			return nil, fmt.Errorf("image was not built")
		}
		if command == "acr repository update" {
			if azureFlag(args, "--write-enabled") != "false" || azureFlag(args, "--delete-enabled") != "false" {
				return nil, fmt.Errorf("image tag must be locked")
			}
			a.locked[image] = true
		}
		return map[string]string{"digest": digest}, nil
	case "functionapp config show":
		if !a.deployed {
			return nil, fmt.Errorf("Function App was not deployed")
		}
		return "DOCKER|" + a.configured[setupAzureApp], nil
	case "containerapp job show":
		reference := a.configured[azureFlag(args, "--name")]
		if reference == "" {
			return nil, fmt.Errorf("job was not deployed")
		}
		return map[string]any{"containers": []any{map[string]string{"image": reference}}}, nil
	case "containerapp job execution list":
		if a.configured[azureFlag(args, "--name")] == "" {
			return nil, fmt.Errorf("job was not deployed")
		}
		return []any{}, nil
	case "containerapp job start":
		job := azureFlag(args, "--name")
		if a.configured[job] == "" || a.executions[job] != "" ||
			job == setupAzureApp+"-ingest" && a.executions[setupAzureApp+"-db-provision"] != "Succeeded" {
			return nil, fmt.Errorf("jobs must be deployed and provision before ingestion without overlap")
		}
		a.executions[job] = "Running"
		return map[string]string{"name": job + "-execution"}, nil
	case "containerapp job execution show":
		job := azureFlag(args, "--name")
		if a.executions[job] != "Running" || azureFlag(args, "--job-execution-name") != job+"-execution" {
			return nil, fmt.Errorf("only the exact started execution can be polled")
		}
		status := "Succeeded"
		if a.failProvision && job == setupAzureApp+"-db-provision" {
			status = "Failed"
		}
		if a.functions != nil {
			if err := a.functions.runJob(job); err != nil {
				return nil, err
			}
		}
		a.executions[job] = status
		return map[string]any{"name": job + "-execution", "properties": map[string]string{"status": status}}, nil
	case "containerapp job replica list":
		return []any{map[string]any{"properties": map[string]any{"containers": []any{
			map[string]string{"name": "database-provision", "runningState": "Terminated", "runningStateDetails": "simulated provisioning failure"},
		}}}}, nil
	case "functionapp restart":
		if a.executions[setupAzureApp+"-ingest"] != "Succeeded" {
			return nil, fmt.Errorf("Function App cannot restart before ingestion succeeds")
		}
		if a.functions != nil {
			if err := a.functions.start(r.Context()); err != nil {
				return nil, err
			}
		}
		a.restarted = true
		return map[string]any{}, nil
	case "resource show":
		if strings.HasSuffix(azureFlag(args, "--ids"), "/config/web") {
			return map[string]any{"ipSecurityRestrictionsDefaultAction": "Allow", "scmIpSecurityRestrictionsDefaultAction": "Deny", "scmIpSecurityRestrictionsUseMain": false}, nil
		}
		return map[string]string{"publicNetworkAccess": "Enabled"}, nil
	case "functionapp config appsettings list":
		return []any{map[string]string{"name": "CAO_POSTGRES_RUN_RETENTION_DAYS", "value": "45"},
			map[string]string{"name": "CAO_POSTGRES_LINKED_RETENTION_DAYS", "value": "45"}}, nil
	default:
		a.unhandled = append(a.unhandled, command)
		return nil, fmt.Errorf("unsupported Azure simulator command %q", command)
	}
}

func (a *azureSetupAPI) deploy(r *http.Request, args []string) (any, error) {
	if !a.group || azureFlag(args, "--resource-group") != setupAzureGroup {
		return nil, fmt.Errorf("deployment requires the exact existing resource group")
	}
	parameters, err := azureSetupParameters(args)
	if err != nil {
		return nil, err
	}
	content, err := os.ReadFile(azureFlag(args, "--template-file"))
	if err != nil || !json.Valid(content) {
		return nil, fmt.Errorf("deployment requires a valid ARM template")
	}
	if strings.HasSuffix(azureFlag(args, "--name"), "-registry") {
		if a.registry || len(parameters) != 2 {
			return nil, fmt.Errorf("registry must be deployed once from the extracted template")
		}
		a.registry = true
		return map[string]any{}, nil
	}
	if a.deployed || len(a.locked) != 3 {
		return nil, fmt.Errorf("full deployment requires three built and locked targets")
	}
	for repository, binding := range map[string][2]string{
		"cao-functions":    {"functionImageDigest", setupAzureApp},
		"cao-ingest":       {"ingestionImageDigest", setupAzureApp + "-ingest"},
		"cao-db-provision": {"provisioningImageDigest", setupAzureApp + "-db-provision"},
	} {
		var parameter struct{ Value string }
		if err := json.Unmarshal(parameters[binding[0]], &parameter); err != nil {
			return nil, fmt.Errorf("missing image digest parameter")
		}
		matched := false
		for image, digest := range a.images {
			if strings.HasPrefix(image, repository+":") && a.locked[image] && parameter.Value == digest {
				a.configured[binding[1]] = setupAzureRegistry + ".azurecr.io/" + repository + "@" + digest
				matched = true
			}
		}
		if !matched {
			return nil, fmt.Errorf("deployment image digest does not match a locked build")
		}
	}
	// The emulator stores only non-secret image bindings, never ARM parameters.
	state, err := json.Marshal(a.configured)
	if err != nil {
		return nil, err
	}
	if _, err := a.storage.request(r.Context(), http.MethodPut, "/setup/deployment.json", state); err != nil {
		return nil, fmt.Errorf("persist simulated deployment: %w", err)
	}
	a.deployed = true
	outputs := map[string]any{}
	for name, value := range map[string]string{"functionHostName": setupAzureHost, "ingestionJobName": setupAzureApp + "-ingest", "provisioningJobName": setupAzureApp + "-db-provision"} {
		outputs[name] = map[string]string{"value": value}
	}
	return map[string]any{"id": azureSetupResourceID("Microsoft.Resources/deployments", azureFlag(args, "--name")),
		"properties": map[string]any{"provisioningState": "Succeeded", "outputs": outputs}}, nil
}

func (a *azureSetupAPI) serveIngress(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "HTTPS "+r.Host+r.URL.Path)
	if !a.references || !a.restarted || a.executions[setupAzureApp+"-ingest"] != "Succeeded" {
		http.Error(w, "simulated deployment is not ready", http.StatusServiceUnavailable)
		return
	}
	if !slices.Contains([]string{setupAzureHost, setupAzureSCM}, r.Host) {
		http.Error(w, "unexpected Azure ingress request", http.StatusForbidden)
		return
	}
	if r.Host == setupAzureSCM {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if a.functions != nil {
		a.functions.handler.ServeHTTP(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "unexpected Azure ingress method", http.StatusForbidden)
		return
	}
	switch r.URL.Path {
	case "/api/health", "/api/readiness":
		if _, err := a.storage.request(r.Context(), http.MethodGet, "/setup/deployment.json", nil); err != nil {
			http.Error(w, "Azurite deployment state unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"redis":{"connected":true},"data":{"available":true}}`))
	case "/api/v1/campaigns":
		w.WriteHeader(http.StatusUnauthorized)
	case "/":
		w.Header().Set("Location", "/auth/login")
		w.WriteHeader(http.StatusFound)
	case "/auth/login":
		w.Header().Set("Location", "https://github.com/login/oauth/authorize?client_id=Iv1.caosetupsim&redirect_uri="+url.QueryEscape("https://"+setupAzureHost+"/auth/callback"))
		w.WriteHeader(http.StatusFound)
	default:
		a.unhandled = append(a.unhandled, "HTTPS "+r.Host+r.URL.Path)
		http.Error(w, "unsupported Azure ingress route", http.StatusNotFound)
	}
}
