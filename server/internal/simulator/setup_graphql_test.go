package simulator

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestSetupRepositoryListGraphQL(t *testing.T) {
	api := NewBootstrapAPI("v0.0.1", nil)
	for _, fixture := range []struct {
		owner, name string
		private     bool
	}{
		{"platform", "zeta", false}, {"platform", "secret", true},
		{"other", "unrelated", false}, {"platform", "alpha", false},
	} {
		if _, err := api.create(fixture.owner, fixture.name, fixture.private); err != nil {
			t.Fatal(err)
		}
	}
	const query = `query($owner:String!){repositoryOwner(login:$owner){repositories(first:100){nodes{nameWithOwner visibility} totalCount pageInfo{hasNextPage endCursor}}}}`
	for _, owner := range []string{"platform", "empty"} {
		t.Run(owner, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{"query": query, "variables": map[string]string{"owner": owner}})
			if err != nil {
				t.Fatal(err)
			}
			result := bootstrapRequest(t, api, "POST", "/graphql", string(body), http.StatusOK)
			nodes := []any{}
			if owner == "platform" {
				for _, repo := range []struct{ name, visibility string }{
					{"alpha", "PUBLIC"}, {"secret", "PRIVATE"}, {"zeta", "PUBLIC"},
				} {
					nodes = append(nodes, map[string]any{"nameWithOwner": owner + "/" + repo.name, "visibility": repo.visibility})
				}
			}
			want := map[string]any{"data": map[string]any{"repositoryOwner": map[string]any{
				"repositories": map[string]any{
					"nodes": nodes, "totalCount": float64(len(nodes)),
					"pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil},
				},
			}}}
			if !reflect.DeepEqual(result, want) {
				t.Fatalf("unexpected repository list: %#v", result)
			}
		})
	}
	if len(api.Unhandled) != 0 {
		t.Fatalf("repository list used unsupported routes: %v", api.Unhandled)
	}
}
