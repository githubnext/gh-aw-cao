package simulator

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSetupAzureSimulatorRejectsUnexpectedRequests(t *testing.T) {
	for _, test := range []struct {
		name, method, path, body string
		status                   int
	}{
		{"wrong method", http.MethodGet, "/az", `[]`, http.StatusNotFound},
		{"wrong route", http.MethodPost, "/unknown", `[]`, http.StatusNotFound},
		{"invalid JSON", http.MethodPost, "/az", `{`, http.StatusBadRequest},
		{"empty command", http.MethodPost, "/az", `[]`, http.StatusBadRequest},
		{"unknown command", http.MethodPost, "/az", `["group","delete"]`, http.StatusBadRequest},
		{"secret in argv", http.MethodPost, "/az", `["account","show","--password","synthetic-admin-password-material-0001"]`, http.StatusBadRequest},
		{"other subscription", http.MethodPost, "/az", `["account","show","--subscription","other"]`, http.StatusForbidden},
		{"external REST URL", http.MethodPost, "/az", `["rest","--method","get","--url","https://management.azure.com/unknown"]`, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			api := &azureSetupAPI{}
			request := httptest.NewRequestWithContext(t.Context(), test.method, test.path, bytes.NewBufferString(test.body))
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status %d, want %d: %s", response.Code, test.status, response.Body)
			}
			if api.group || api.registry || api.deployed || api.restarted || api.references {
				t.Fatal("rejected simulator request changed Azure state")
			}
		})
	}
}

func TestSetupAzureSimulatorRequiresDeploymentOrdering(t *testing.T) {
	for _, args := range [][]string{
		{"acr", "build", "--registry", setupAzureRegistry, "--platform", "linux/amd64"},
		{"containerapp", "job", "show", "--name", setupAzureApp + "-ingest"},
		{"containerapp", "job", "start", "--name", setupAzureApp + "-ingest"},
		{"containerapp", "job", "execution", "show", "--name", setupAzureApp + "-ingest", "--job-execution-name", setupAzureApp + "-ingest-execution"},
		{"functionapp", "restart", "--name", setupAzureApp},
		{"rest", "--method", "get", "--url", azureSetupResourceID("Microsoft.Web/sites", setupAzureApp) + "/config/configreferences/appsettings?api-version=2023-12-01"},
	} {
		t.Run(azureCommand(args), func(t *testing.T) {
			api := &azureSetupAPI{}
			body, err := json.Marshal(args)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/az", bytes.NewReader(body))
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("simulator accepted an out-of-order operation: %s", response.Body)
			}
		})
	}
}
