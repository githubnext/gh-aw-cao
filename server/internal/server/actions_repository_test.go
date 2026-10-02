package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestActionsRepositoryMetadataResponse(t *testing.T) {
	for _, test := range []struct {
		name    string
		padding int
		status  int
		valid   bool
	}{
		{"full GitHub repository response", 8 << 10, http.StatusOK, true},
		{"oversized response", 64 << 10, http.StatusOK, false},
		{"denied repository", 0, http.StatusForbidden, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			api := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/repos/githubnext/gh-aw-cao" ||
					request.Header.Get("Authorization") != "Bearer "+testActionsToken ||
					request.Header.Get("X-GitHub-Api-Version") != actionsGitHubAPIVersion {
					t.Error("repository identity request is invalid")
					response.WriteHeader(http.StatusBadRequest)
					return
				}
				response.WriteHeader(test.status)
				_ = json.NewEncoder(response).Encode(map[string]any{
					"id": 1302952722, "full_name": "githubnext/gh-aw-cao",
					"owner": map[string]any{"id": 89615882}, "default_branch": "main",
					"description": strings.Repeat("x", test.padding),
				})
			}))
			defer api.Close()
			metadata, err := actionsRepositoryMetadataForToken(t.Context(), Config{
				ActionsRepository: "githubnext/gh-aw-cao", GitHubAPIURL: api.URL,
				ActionsHTTPClient: api.Client(),
			}, testActionsToken)
			if (err == nil) != test.valid {
				t.Fatalf("metadata=%+v error=%v, want valid=%t", metadata, err, test.valid)
			}
			if test.valid && metadata != (actionsRepositoryMetadata{
				FullName: "githubnext/gh-aw-cao", ID: "1302952722",
				OwnerID: "89615882", DefaultBranch: "main",
			}) {
				t.Fatalf("unexpected repository identity: %+v", metadata)
			}
		})
	}
}
