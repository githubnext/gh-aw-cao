package simulator

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func bootstrapRequest(t *testing.T, api *BootstrapAPI, method, path, body string, status int) map[string]any {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != status {
		t.Fatalf("%s %s: status %d, want %d; %s", method, path, response.Code, status, response.Body.String())
	}
	var result map[string]any
	if response.Body.Len() > 0 {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func TestBootstrapRepositoryLifecycle(t *testing.T) {
	api := NewBootstrapAPI("v1.0.0", nil)
	bootstrapRequest(t, api, "GET", "/repos/platform/control", "", http.StatusNotFound)
	repository := bootstrapRequest(t, api, "POST", "/orgs/platform/repos", `{"name":"control","private":true}`, http.StatusCreated)
	if repository["full_name"] != "platform/control" || repository["private"] != true {
		t.Fatalf("unexpected created repository: %v", repository)
	}
	bootstrapRequest(t, api, "POST", "/orgs/platform/repos", `{"name":"control"}`, http.StatusUnprocessableEntity)
	bootstrapRequest(t, api, "POST", "/user/repos", `{"name":"../escape"}`, http.StatusUnprocessableEntity)
	bootstrapRequest(t, api, "POST", "/user/repos", `{`, http.StatusBadRequest)
	user := bootstrapRequest(t, api, "POST", "/user/repos", `{"name":"personal","private":false}`, http.StatusCreated)
	if user["full_name"] != "simulator/personal" || user["id"] == repository["id"] {
		t.Fatalf("unexpected personal repository: %v", user)
	}
	repository = bootstrapRequest(t, api, "GET", "/api/v3/repos/platform/control", "", http.StatusOK)
	if repository["visibility"] != "private" {
		t.Fatalf("private visibility lost: %v", repository)
	}
	bootstrapRequest(t, api, "PATCH", "/repos/platform/control", `{}`, http.StatusBadRequest)
	repository = bootstrapRequest(t, api, "PATCH", "/repos/platform/control", `{"private":false}`, http.StatusOK)
	if repository["visibility"] != "public" {
		t.Fatalf("visibility was not updated: %v", repository)
	}
	bootstrapRequest(t, api, "GET", "/repos/platform/control/unsupported", "", http.StatusNotFound)
	if !reflect.DeepEqual(api.Unhandled, []string{"GET /repos/platform/control/unsupported"}) {
		t.Fatalf("unexpected unsupported routes: %v", api.Unhandled)
	}
}

func TestBootstrapPagesAndVariables(t *testing.T) {
	api := NewBootstrapAPI("v1.0.0", nil)
	bootstrapRequest(t, api, "POST", "/orgs/platform/repos", `{"name":"control"}`, http.StatusCreated)
	pages := "/repos/platform/control/pages"
	bootstrapRequest(t, api, "GET", pages, "", http.StatusNotFound)
	bootstrapRequest(t, api, "PUT", pages, `{"build_type":"workflow"}`, http.StatusNotFound)
	bootstrapRequest(t, api, "POST", pages, `{"build_type":"legacy"}`, http.StatusUnprocessableEntity)
	created := bootstrapRequest(t, api, "POST", pages, `{"build_type":"workflow"}`, http.StatusCreated)
	if created["build_type"] != "workflow" || created["public"] != true {
		t.Fatalf("unexpected Pages site: %v", created)
	}
	bootstrapRequest(t, api, "POST", pages, `{"build_type":"workflow"}`, http.StatusConflict)
	bootstrapRequest(t, api, "PUT", pages, `{"build_type":"workflow"}`, http.StatusOK)
	bootstrapRequest(t, api, "DELETE", pages, "", http.StatusNoContent)
	bootstrapRequest(t, api, "GET", pages, "", http.StatusNotFound)
	variables := "/repos/platform/control/actions/variables"
	variable := variables + "/GH_AW_GITHUB_AUTH_MODE"
	bootstrapRequest(t, api, "GET", variable, "", http.StatusNotFound)
	bootstrapRequest(t, api, "POST", variables, `{"name":"GH_AW_GITHUB_AUTH_MODE","value":"workflow-token"}`, http.StatusCreated)
	bootstrapRequest(t, api, "POST", variables, `{"name":"GH_AW_GITHUB_AUTH_MODE","value":"workflow-token"}`, http.StatusConflict)
	bootstrapRequest(t, api, "PATCH", variable, `{"value":"github-app"}`, http.StatusNoContent)
	value := bootstrapRequest(t, api, "GET", variable, "", http.StatusOK)
	if value["value"] != "github-app" {
		t.Fatalf("variable update was not persisted: %v", value)
	}
	if len(api.Unhandled) != 0 {
		t.Fatalf("supported lifecycle recorded unknown routes: %v", api.Unhandled)
	}
}

func TestBootstrapGraphQL(t *testing.T) {
	api := NewBootstrapAPI("v1.0.0", nil)
	created := bootstrapRequest(t, api, "POST", "/graphql",
		`{"query":"mutation($input:CreateRepositoryInput!){createRepository(input:$input){repository{nameWithOwner isPrivate}}}","variables":{"input":{"name":"control","ownerId":"O_platform","visibility":"PRIVATE"}}}`,
		http.StatusOK)
	expected := map[string]any{"data": map[string]any{"createRepository": map[string]any{
		"repository": map[string]any{"nameWithOwner": "platform/control", "isPrivate": true},
	}}}
	if !reflect.DeepEqual(created, expected) {
		t.Fatalf("unexpected GraphQL mutation: %v", created)
	}
	selected := bootstrapRequest(t, api, "POST", "/api/graphql",
		`{"query":"query($owner:String!,$name:String!){repository(owner:$owner,name:$name){name owner{login} visibility}}","variables":{"owner":"platform","name":"control"}}`,
		http.StatusOK)
	expected = map[string]any{"data": map[string]any{"repository": map[string]any{
		"name": "control", "owner": map[string]any{"login": "platform"}, "visibility": "PRIVATE",
	}}}
	if !reflect.DeepEqual(selected, expected) {
		t.Fatalf("response leaked unrequested fields: %v", selected)
	}
	renamed := bootstrapRequest(t, api, "POST", "/graphql",
		`{"query":"query($repo:String!){repository(owner:\"platform\",name:$repo){name}}","variables":{"repo":"control"}}`,
		http.StatusOK)
	if !reflect.DeepEqual(renamed, map[string]any{"data": map[string]any{"repository": map[string]any{"name": "control"}}}) {
		t.Fatalf("GraphQL arguments failed: %v", renamed)
	}
	viewer := bootstrapRequest(t, api, "POST", "/graphql", `{"query":"query{viewer{account:login}}"}`, http.StatusOK)
	if !reflect.DeepEqual(viewer, map[string]any{"data": map[string]any{"viewer": map[string]any{"account": "simulator"}}}) {
		t.Fatalf("GraphQL alias failed: %v", viewer)
	}
	unknown := bootstrapRequest(t, api, "POST", "/graphql", `{"query":"query{unsupported}"}`, http.StatusOK)
	if unknown["errors"] == nil {
		t.Fatal("unsupported GraphQL query succeeded")
	}
	missing := bootstrapRequest(t, api, "POST", "/graphql",
		`{"query":"query{repository(owner:$owner,name:$name){name}}","variables":{"owner":"platform","name":"missing"}}`,
		http.StatusOK)
	if missing["errors"] == nil {
		t.Fatal("missing repository succeeded")
	}
	for _, malformed := range []string{
		"", "query{viewer", "query{viewer(login:()", "query{...Frag}",
		"fragment A on User{...A} query{viewer{...A}}",
	} {
		if _, err := bootstrapFields(malformed); err == nil {
			t.Errorf("unsupported selection accepted: %q", malformed)
		}
	}
	fragment := bootstrapRequest(t, api, "POST", "/graphql",
		`{"query":"fragment Details on Repository{name owner{login}} query{repository(owner:\"platform\",name:\"control\"){...Details parent{...Details}}}"}`,
		http.StatusOK)
	if !reflect.DeepEqual(fragment, map[string]any{"data": map[string]any{"repository": map[string]any{
		"name": "control", "owner": map[string]any{"login": "platform"}, "parent": nil,
	}}}) {
		t.Fatalf("GraphQL fragments failed: %v", fragment)
	}
	before := len(api.Repositories)
	invalid := bootstrapRequest(t, api, "POST", "/graphql",
		`{"query":"mutation{createRepository(input:$input){repository{unsupported}}}","variables":{"input":{"name":"should-not-exist"}}}`,
		http.StatusOK)
	if invalid["errors"] == nil || len(api.Repositories) != before {
		t.Fatal("unsupported mutation selection created a repository")
	}
}

func TestBootstrapReleasesAndGitIsolation(t *testing.T) {
	api := NewBootstrapAPI("v1.0.0", map[string][]byte{"checksums.txt": []byte("fixture checksum")})
	release := bootstrapRequest(t, api, "GET", "/repos/githubnext/gh-cao/releases/tags/v1.0.0", "", http.StatusOK)
	if release["tag_name"] != "v1.0.0" || release["draft"] != false {
		t.Fatalf("unexpected release: %v", release)
	}
	asset := httptest.NewRecorder()
	api.ServeHTTP(asset, httptest.NewRequestWithContext(t.Context(), "GET", "/githubnext/gh-cao/releases/download/v1.0.0/checksums.txt", nil))
	if asset.Code != http.StatusOK || asset.Body.String() != "fixture checksum" {
		t.Fatalf("asset download failed: %d %s", asset.Code, asset.Body.String())
	}
	bootstrapRequest(t, api, "GET", "/githubnext/gh-cao/releases/download/v1.0.0/missing", "", http.StatusNotFound)
	calls := 0
	api.Git = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	})
	bootstrapRequest(t, api, "GET", "/platform/missing.git/info/refs", "", http.StatusNotFound)
	if calls != 0 {
		t.Fatal("unknown repository reached the Git backend")
	}
	bootstrapRequest(t, api, "POST", "/orgs/platform/repos", `{"name":"control"}`, http.StatusCreated)
	bootstrapRequest(t, api, "GET", "/platform/control.git/info/refs", "", http.StatusNoContent)
	if calls != 1 {
		t.Fatal("created repository did not reach the Git backend")
	}
}
