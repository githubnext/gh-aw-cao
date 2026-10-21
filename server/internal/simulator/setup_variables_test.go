package simulator

import (
	"net/http"
	"testing"
)

func TestSetupVariablesList(t *testing.T) {
	api := NewBootstrapAPI("v0.0.1", nil)
	repo, err := api.create("platform", "control", false)
	if err != nil {
		t.Fatal(err)
	}
	const endpoint = "/repos/platform/control/actions/variables?per_page=100"
	setupAssertJSON(t, bootstrapRequest(t, api, "GET", endpoint, "", http.StatusOK), map[string]any{
		"total_count": 0, "variables": []any{},
	})
	repo.Variables["GH_AW_GITHUB_AUTH_MODE"] = "workflow-token"
	repo.Variables["GH_AW_DEFAULT_ADMISSION_URL"] = "https://authority.example.invalid/api/admission"
	setupAssertJSON(t, bootstrapRequest(t, api, "GET", endpoint, "", http.StatusOK), map[string]any{
		"total_count": 2,
		"variables": []map[string]string{
			{"name": "GH_AW_DEFAULT_ADMISSION_URL", "value": "https://authority.example.invalid/api/admission"},
			{"name": "GH_AW_GITHUB_AUTH_MODE", "value": "workflow-token"},
		},
	})
	if len(api.Unhandled) != 0 {
		t.Fatalf("variable listing used unsupported routes: %v", api.Unhandled)
	}
}
