package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestRemoteMCPIntegration(t *testing.T) {
	if os.Getenv("CAO_REMOTE_MCP_TEST") != "1" {
		t.Skip("remote MCP integration is enabled by the push-to-main workflow")
	}
	if os.Getenv("GITHUB_REPOSITORY") != "githubnext/gh-aw-cao" ||
		os.Getenv("GITHUB_REF") != "refs/heads/main" ||
		os.Getenv("GITHUB_EVENT_NAME") != "push" {
		t.Fatal("remote MCP integration requires a push to main in the server repository")
	}
	token := os.Getenv("GITHUB_TOKEN")
	requestURL := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL")
	requestToken := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if token == "" || requestURL == "" || requestToken == "" {
		t.Fatal("remote MCP integration requires the Actions token and OIDC request credentials")
	}

	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	oidc, err := requestMCPAssertion(ctx, requestURL, requestToken)
	if err != nil {
		t.Fatalf("request Actions assertion: %v", err)
	}
	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: remoteMCPTransport{assertion: oidc, token: token, base: http.DefaultTransport},
	}
	if err := exerciseMCP(ctx, actionsMCPAudience, client); err != nil {
		t.Fatalf("remote MCP integration failed: %v", err)
	}
	t.Log("listed tools, read the query catalog, and ran a bounded named query")
}

func requestMCPAssertion(ctx context.Context, rawURL, requestToken string) (string, error) {
	endpoint, err := url.Parse(rawURL)
	if err != nil || endpoint.Scheme != "https" ||
		!strings.HasSuffix(endpoint.Hostname(), ".actions.githubusercontent.com") ||
		endpoint.User != nil || (endpoint.Port() != "" && endpoint.Port() != "443") {
		return "", errors.New("invalid Actions OIDC request URL")
	}
	parameters := endpoint.Query()
	parameters.Set("audience", actionsMCPAudience)
	endpoint.RawQuery = parameters.Encode()
	// #nosec G704 -- HTTPS and the GitHub Actions OIDC host are checked above.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+requestToken)
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	// #nosec G704 -- the validated OIDC host cannot redirect this client.
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("Actions OIDC request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Actions OIDC request returned status %d", response.StatusCode)
	}
	var payload struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16384)).Decode(&payload); err != nil ||
		payload.Value == "" || len(payload.Value) > 8192 {
		return "", errors.New("Actions OIDC response was invalid")
	}
	return payload.Value, nil
}

type remoteMCPTransport struct {
	assertion string
	token     string
	base      http.RoundTripper
}

func (transport remoteMCPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme != "https" || request.URL.Host != "cao.githubnext.com" {
		return nil, errors.New("unexpected remote MCP destination")
	}
	copy := request.Clone(request.Context())
	copy.Header.Set("Authorization", "Bearer "+transport.assertion)
	copy.Header.Set("X-GitHub-Actions-Token", transport.token)
	return transport.base.RoundTrip(copy)
}

func exerciseMCP(ctx context.Context, endpoint string, httpClient *http.Client) error {
	client := mcp.NewClient(&mcp.Implementation{Name: "cao-integration", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: endpoint, HTTPClient: httpClient,
	}, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = session.Close() }()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		return fmt.Errorf("list tools: %w", err)
	}
	found := map[string]bool{}
	for _, tool := range tools.Tools {
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			return fmt.Errorf("tool %q is not declared read-only", tool.Name)
		}
		found[tool.Name] = true
	}
	if !found["cao_catalog"] || !found["cao_query"] {
		return errors.New("required read-only MCP tools are missing")
	}
	catalog, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "cao_catalog", Arguments: map[string]any{"kind": "queries"},
	})
	if err != nil || catalog == nil || catalog.IsError {
		return errors.New("catalog query failed")
	}
	payload, ok := catalog.StructuredContent.(map[string]any)
	if !ok {
		return errors.New("catalog response is not structured")
	}
	queries, ok := payload["queries"].([]any)
	if !ok || len(queries) == 0 {
		return errors.New("catalog has no queries")
	}
	// Choose a stable, parameter-free query only after discovering it in the catalog.
	var queryID string
	for _, item := range queries {
		entry, ok := item.(map[string]any)
		if !ok || entry["id"] != "workflow-run-totals" {
			continue
		}
		execution, ok := entry["execution"].(map[string]any)
		parameters, parametersOK := entry["parameters"].([]any)
		if ok && execution["local"] == true && parametersOK && len(parameters) == 0 {
			queryID = "workflow-run-totals"
		}
	}
	if queryID == "" {
		return errors.New("catalog does not offer the expected parameter-free query")
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "cao_query", Arguments: map[string]any{"id": queryID, "limit": 1},
	})
	if err != nil || result == nil || result.IsError {
		return errors.New("named query failed")
	}
	data, ok := result.StructuredContent.(map[string]any)
	if !ok || data["query"] != queryID {
		return errors.New("named query response is invalid")
	}
	rows, rowsOK := data["rows"].([]any)
	metadata, metadataOK := data["metadata"].(map[string]any)
	if !rowsOK || len(rows) > 1 || !metadataOK || metadata["availability"] == "unavailable" {
		return errors.New("named query returned invalid or unavailable data")
	}
	return nil
}

func TestRemoteMCPProbeAgainstLocalServer(t *testing.T) {
	app := newMCPTestApp(t, true)
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	client := &http.Client{Transport: bearerTransport{
		token: testAccessToken, base: http.DefaultTransport,
	}}
	if err := exerciseMCP(t.Context(), server.URL+"/mcp", client); err != nil {
		t.Fatal(err)
	}
}
