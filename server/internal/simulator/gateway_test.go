package simulator

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gatewayRequest(t *testing.T, api *GatewayAPI, method, endpoint, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), method, endpoint, strings.NewReader(body))
	request.Header.Set("Authorization", token)
	request.Header.Set("Accept", "application/vnd.github.raw+json")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	return response
}

func TestGatewayAPIImmutableWorkflowDiscovery(t *testing.T) {
	name := ".github/workflows/test.lock.yml"
	original := []byte("name: original\n")
	api, err := NewGatewayAPI(map[string][]byte{name: original})
	if err != nil {
		t.Fatal(err)
	}
	original[0] = 'X'
	if err := api.Publish(strings.Repeat("b", 40), map[string][]byte{}); err != nil {
		t.Fatal(err)
	}
	old := gatewayRequest(t, api, http.MethodGet, gatewayRepositoryPath+"/contents/"+name+"?ref="+strings.Repeat("a", 40),
		"token "+gatewayReceivingToken, "")
	if old.Code != 200 || old.Body.String() != "name: original\n" {
		t.Fatal("publishing a new head mutated a pinned workflow")
	}
	current := gatewayRequest(t, api, http.MethodGet, "/api/v3"+gatewayRepositoryPath+"/contents/.github/workflows?ref="+strings.Repeat("b", 40),
		"token "+gatewayReceivingToken, "")
	if current.Code != 200 || current.Body.String() != "[]\n" {
		t.Fatal("empty workflow directory or enterprise API prefix not supported")
	}
	if err := api.Publish(strings.Repeat("a", 40), map[string][]byte{name: []byte("changed")}); err == nil {
		t.Fatal("existing commit was mutable")
	}
	for _, files := range []map[string][]byte{
		{"../test.lock.yml": []byte("invalid")},
		{".github/workflows/../test.lock.yml": []byte("invalid")},
		{name: make([]byte, (8<<20)+1)},
	} {
		if _, err := NewGatewayAPI(files); err == nil {
			t.Fatal("invalid or oversized workflow fixture accepted")
		}
	}
}

func TestGatewayAPIScopedRolesAndDispatch(t *testing.T) {
	api, err := NewGatewayAPI(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, method, endpoint, token, body string
		status                              int
	}{
		{"no_credentials", "GET", "/repositories/1001", "", "", 401},
		{"invalid_auth_scheme", "GET", "/repositories/1001", "Basic " + gatewayReceivingToken, "", 401},
		{"unknown_repository", "GET", "/repositories/9999", "token " + gatewayReceivingToken, "", 404},
		{"unknown_route", "GET", gatewayRepositoryPath + "/unknown", "token " + gatewayReceivingToken, "", 404},
		{"unscoped_mint", "POST", "/app/installations/1/access_tokens", "Bearer synthetic-app-jwt", `{}`, 422},
		{"wrong_repository_mint", "POST", "/app/installations/1/access_tokens", "Bearer synthetic-app-jwt", `{"repository_ids":[9999]}`, 422},
		{"scoped_mint", "POST", "/app/installations/2/access_tokens", "Bearer synthetic-app-jwt", `{"repository_ids":[1001]}`, 200},
		{"receiver_cannot_write", "POST", gatewayRepositoryPath + "/dispatches", "token " + gatewayReceivingToken, `{"event_type":"test","client_payload":{}}`, 403},
		{"invalid_dispatch", "POST", gatewayRepositoryPath + "/dispatches", "token " + gatewayDispatchToken, `{"event_type":"test","extra":true}`, 422},
		{"oversized_dispatch", "POST", gatewayRepositoryPath + "/dispatches", "token " + gatewayDispatchToken, strings.Repeat(" ", 65536), 413},
		{"dispatch", "POST", gatewayRepositoryPath + "/dispatches", "token " + gatewayDispatchToken, `{"event_type":"test","client_payload":{"synthetic":true}}`, 204},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := gatewayRequest(t, api, test.method, test.endpoint, test.token, test.body)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d", response.Code, test.status)
			}
		})
	}
	dispatches := api.Dispatches()
	if len(dispatches) != 1 || dispatches[0].EventType != "test" ||
		!bytes.Contains(dispatches[0].Payload, []byte(`"synthetic":true`)) {
		t.Fatal("accepted dispatch was not recorded")
	}
	dispatches[0].Payload[0] = 'X'
	if api.Dispatches()[0].Payload[0] != '{' {
		t.Fatal("dispatch observations exposed mutable simulator state")
	}
	if api.Stats().TokenMints != 1 {
		t.Fatal("invalid token mints were accepted")
	}
}

func TestGatewayAPIFixtureCapacity(t *testing.T) {
	api, err := NewGatewayAPI(nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < 8; i++ {
		if err := api.Publish(fmt.Sprintf("%040x", i), nil); err != nil {
			t.Fatal("valid revision within fixture capacity rejected", err)
		}
	}
	if err := api.Publish(fmt.Sprintf("%040x", 8), nil); err == nil {
		t.Fatal("ninth revision exceeded the fixture bound")
	}
	if err := api.Publish(fmt.Sprintf("%040x", 7), nil); err != nil {
		t.Fatal("unchanged revision incorrectly consumed capacity", err)
	}
	files := map[string][]byte{
		".github/workflows/one.lock.yml": make([]byte, 8<<20),
		".github/workflows/two.lock.yml": make([]byte, 8<<20),
	}
	if _, err := NewGatewayAPI(files); err != nil {
		t.Fatal("exact 16 MiB fixture budget was rejected", err)
	}
	files[".github/workflows/three.lock.yml"] = []byte("overflow")
	if _, err := NewGatewayAPI(files); err == nil {
		t.Fatal("fixture above the 16 MiB budget was accepted")
	}
	for i := range 129 {
		response := gatewayRequest(t, api, "POST", gatewayRepositoryPath+"/dispatches",
			"token "+gatewayDispatchToken, `{"event_type":"test","client_payload":{}}`)
		want := 204
		if i == 128 {
			want = 503
		}
		if response.Code != want {
			t.Fatalf("dispatch %d status=%d want=%d", i, response.Code, want)
		}
	}
	if len(api.Dispatches()) != 128 {
		t.Fatal("dispatch observations exceeded their retained bound")
	}
}
