package simulator

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	setupAzureSubscription = "00000000-0000-4000-8000-000000000001"
	setupAzureTenant       = "00000000-0000-4000-8000-000000000002"
	setupAzureApp          = "fa-cao-setup-sim"
	setupAzureRegistry     = "acrcaosetupsim"
	setupAzureGroup        = "rg-cao-setup-sim"
	setupAzureHost         = setupAzureApp + ".azurewebsites.net"
	setupAzureSCM          = setupAzureApp + ".scm.azurewebsites.net"
)

// Test-only az subprocess adapter. No installed az, Azure login, or cloud
// credential can be used: every command goes to this exact loopback fixture.
func TestSetupAzureCLIProcess(t *testing.T) {
	endpoint := os.Getenv("CAO_SETUP_AZURE_ENDPOINT")
	if endpoint == "" {
		return
	}
	transport, err := NewLocalTransport(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	index := slices.Index(os.Args, "--")
	if index < 0 {
		t.Fatal("missing Azure command arguments")
	}
	content, err := json.Marshal(os.Args[index+1:])
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint, bytes.NewReader(content)) // #nosec G704 -- NewLocalTransport validates and confines traffic to the numeric-loopback endpoint.
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: transport, Timeout: 2 * time.Minute}
	response, err := client.Do(request) // #nosec G704 -- transport rejects requests outside the exact simulator endpoint, including redirects.
	if err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	_ = response.Body.Close()
	transport.CloseIdleConnections()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		_, _ = fmt.Fprint(os.Stderr, string(output))
		os.Exit(1)
	}
	_, _ = os.Stdout.Write(output)
	os.Exit(0)
}

type azureSetupAPI struct {
	mu               sync.Mutex
	calls, unhandled []string
	providers        []map[string]any
	storage          *azureBlobStore
	group, registry  bool
	deployed         bool
	restarted        bool
	references       bool
	referenceReads   int
	drift            bool
	failProvision    bool
	images           map[string]string
	locked           map[string]bool
	configured       map[string]string
	executions       map[string]string
	functions        *setupAzureFunctions
}

func newAzureSetupAPI(t *testing.T, catalog string, storage *azureBlobStore) *azureSetupAPI {
	t.Helper()
	api := &azureSetupAPI{
		storage: storage, images: map[string]string{}, locked: map[string]bool{},
		configured: map[string]string{}, executions: map[string]string{},
	}
	var document any
	if err := json.Unmarshal(setupRead(t, filepath.Join(catalog, "server/azure/main.json")), &document); err != nil {
		t.Fatal(err)
	}
	providers := map[string][]map[string]any{}
	for _, namespace := range []string{"Microsoft.App", "Microsoft.ContainerRegistry", "Microsoft.DBforPostgreSQL",
		"Microsoft.Insights", "Microsoft.KeyVault", "Microsoft.Network", "Microsoft.OperationalInsights", "Microsoft.Storage", "Microsoft.Web"} {
		providers[namespace] = nil
	}
	var visit func(any)
	visit = func(value any) {
		switch node := value.(type) {
		case map[string]any:
			resourceType, _ := node["type"].(string)
			namespace, kind, ok := strings.Cut(resourceType, "/")
			if ok && strings.HasPrefix(namespace, "Microsoft.") {
				providers[namespace] = append(providers[namespace], map[string]any{"resourceType": kind, "locations": []string{"West US 3"}})
			}
			for _, child := range node {
				visit(child)
			}
		case []any:
			for _, child := range node {
				visit(child)
			}
		}
	}
	visit(document)
	for namespace, types := range providers {
		api.providers = append(api.providers, map[string]any{"namespace": namespace, "registrationState": "Registered", "resourceTypes": types})
	}
	return api
}

func azureCommand(args []string) string {
	end := slices.IndexFunc(args, func(arg string) bool { return strings.HasPrefix(arg, "-") })
	if end < 0 {
		end = len(args)
	}
	return strings.Join(args[:end], " ")
}

func azureFlag(args []string, name string) string {
	index := slices.Index(args, name)
	if index < 0 || index+1 >= len(args) {
		return ""
	}
	return args[index+1]
}

func (a *azureSetupAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Method != http.MethodPost || r.URL.Path != "/az" {
		a.unhandled = append(a.unhandled, r.Method+" "+r.URL.Path)
		http.Error(w, "unsupported Azure simulator route", http.StatusNotFound)
		return
	}
	var args []string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&args); err != nil || len(args) == 0 {
		http.Error(w, "invalid Azure command", http.StatusBadRequest)
		return
	}
	for _, argument := range args {
		for _, value := range setupAzureSecrets() {
			if strings.Contains(argument, value) {
				http.Error(w, "secure parameter value passed in Azure argv", http.StatusBadRequest)
				return
			}
		}
	}
	command := azureCommand(args)
	a.calls = append(a.calls, command)
	if subscription := azureFlag(args, "--subscription"); subscription != "" && subscription != setupAzureSubscription {
		http.Error(w, "Azure simulator subscription not allowed", http.StatusForbidden)
		return
	}
	result, err := a.run(r, command, args)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (a *azureSetupAPI) run(r *http.Request, command string, args []string) (any, error) {
	switch command {
	case "version":
		return map[string]string{"azure-cli": "2.67.0"}, nil
	case "account show":
		return map[string]any{"id": setupAzureSubscription, "tenantId": setupAzureTenant, "state": "Enabled", "user": map[string]string{"type": "user"}}, nil
	case "group exists":
		return a.group, nil
	case "resource list":
		if !a.deployed {
			return []any{}, nil
		}
		return []any{map[string]string{"id": azureSetupResourceID("Microsoft.Web/sites", setupAzureApp), "type": "Microsoft.Web/sites"}}, nil
	case "provider list":
		return a.providers, nil
	case "storage account check-name", "acr check-name":
		return map[string]bool{"nameAvailable": !a.deployed}, nil
	case "keyvault list-deleted":
		return []any{}, nil
	case "postgres flexible-server list-skus":
		return []any{map[string]any{"name": "Burstable", "supportedServerSkus": []any{map[string]string{"name": "Standard_B2s"}}}}, nil
	case "rest":
		return a.rest(args)
	case "deployment sub what-if", "deployment group what-if":
		if _, err := azureSetupParameters(args); err != nil {
			return nil, err
		}
		kind := "Create"
		if a.drift {
			kind = "Ignore"
		}
		return map[string]any{"status": "Succeeded", "changes": []any{
			map[string]string{"resourceId": azureSetupResourceID("Microsoft.Web/sites", setupAzureApp), "changeType": kind},
		}}, nil
	default:
		return a.apply(r, command, args)
	}
}

func (a *azureSetupAPI) rest(args []string) (any, error) {
	target := azureFlag(args, "--url")
	prefix := "/subscriptions/" + setupAzureSubscription
	if azureFlag(args, "--method") == "get" {
		switch target {
		case prefix + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01",
			prefix + "/resourceGroups/" + setupAzureGroup + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01":
			return map[string]any{"value": []any{map[string]any{"actions": []string{"*"}, "notActions": []string{}}}}, nil
		case prefix + "/providers/Microsoft.Web/geoRegions?api-version=2024-11-01&sku=EP1&linuxWorkersEnabled=true":
			return map[string]any{"value": []any{map[string]string{"name": "West US 3"}}}, nil
		case azureSetupResourceID("Microsoft.Web/sites", setupAzureApp) + "/config/configreferences/appsettings?api-version=2023-12-01":
			if !a.restarted {
				return nil, fmt.Errorf("Key Vault references read before restart")
			}
			a.referenceReads++
			status := "AccessToKeyVaultDenied"
			if a.referenceReads > 1 {
				status = "Resolved"
				a.references = true
			}
			return map[string]any{"value": []any{map[string]any{"name": "CAO_POSTGRES_URL", "properties": map[string]string{"status": status}}}}, nil
		}
	}
	if azureFlag(args, "--method") == "post" && strings.HasPrefix(target, prefix+"/providers/") {
		path, _, _ := strings.Cut(strings.TrimPrefix(target, prefix+"/providers/"), "?")
		if slices.Contains([]string{"Microsoft.KeyVault/checkNameAvailability", "Microsoft.Web/checkNameAvailability",
			"Microsoft.DBforPostgreSQL/locations/westus3/checkNameAvailability"}, path) {
			return map[string]bool{"nameAvailable": !a.deployed}, nil
		}
	}
	a.unhandled = append(a.unhandled, "rest "+target)
	return nil, fmt.Errorf("unsupported Azure simulator REST request")
}

func azureSetupResourceID(kind, name string) string {
	return "/subscriptions/" + setupAzureSubscription + "/resourceGroups/" + setupAzureGroup + "/providers/" + kind + "/" + name
}

func installAzureCLIAdapter(t *testing.T, api *azureSetupAPI) (directory, endpoint string) {
	t.Helper()
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	directory = t.TempDir()
	for _, tool := range []string{"gh", "git", "sh"} {
		source, err := exec.LookPath(tool)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(source, filepath.Join(directory, tool)); err != nil {
			t.Fatal(err)
		}
	}
	setupWrite(t, filepath.Join(directory, "az"), []byte("#!/bin/sh\nexec \"$CAO_SETUP_TEST_BINARY\" -test.run='^TestSetupAzureCLIProcess$' -- \"$@\"\n"))
	if err := os.Chmod(filepath.Join(directory, "az"), 0o700); err != nil { // #nosec G302 -- test-only executable adapter.
		t.Fatal(err)
	}
	return directory, server.URL + "/az"
}
