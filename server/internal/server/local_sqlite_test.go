package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/operational"
	"github.com/githubnext/gh-cao/server/internal/query"
	"github.com/githubnext/gh-cao/server/internal/testutil"
)

func newSQLiteTestApp(t *testing.T, mcpEnabled bool) (*App, string) {
	t.Helper()
	path := testutil.SQLiteSnapshot(t, map[string][]model.Row{
		"repositories": {
			{"id": "repository:octo/one", "owner": "octo", "name": "one"},
			{"id": "repository:octo/two", "owner": "octo", "name": "two"},
		},
		"workflows": {{"id": "workflow:one", "repositoryId": "repository:octo/one", "path": "one.md", "name": "One"}},
		"runs": {
			{"id": "run:one", "repositoryId": "repository:octo/one", "workflowId": "workflow:one",
				"owner": "octo", "repository": "one", "startedAt": "2026-10-01T12:00:00Z", "duration": 10,
				"conclusion": "success", "status": "completed", "githubRunId": "1", "attempt": 1},
		},
	})
	site := t.TempDir()
	if err := os.WriteFile(filepath.Join(site, "index.html"), []byte("<html><head></head><body>Dashboard</body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	definitions, err := ParseDashboardQueries("../../../dashboard/site/src/agent/queries.generated.json")
	if err != nil {
		t.Fatal(err)
	}
	app, err := NewLocalSQLiteApp(t.Context(), path, Config{
		Listen: "127.0.0.1:8080", SiteDirectory: site, AccessToken: testAccessToken,
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		DashboardQueries:    definitions, AgentCatalogPath: testAgentCatalog, MCPContractPath: testMCPContract,
		MCPEnabled: mcpEnabled, Logger: log.New(io.Discard, "", 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.Stop(context.WithoutCancel(t.Context())); err != nil {
			t.Error(err)
		}
	})
	return app, path
}

func TestLocalSQLitePreservesQueryAdmissionOverride(t *testing.T) {
	original, path := newSQLiteTestApp(t, false)
	config := original.config
	config.Database = nil
	config.RateLimits.Query.Capacity = 3
	app, err := NewLocalSQLiteApp(t.Context(), path, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.Stop(context.WithoutCancel(t.Context())); err != nil {
			t.Error(err)
		}
	})
	if app.config.RateLimits.Query.Capacity != 3 {
		t.Fatal("local snapshot serving widened an explicit query-admission limit")
	}
}

func TestLocalSQLiteHTTPAndLifecycle(t *testing.T) {
	app, path := newSQLiteTestApp(t, false)
	if app.config.RateLimits.Query.Capacity != 300 {
		t.Fatal("local snapshot query admission must allow ordinary page navigation")
	}
	if !app.config.QueryCache.Disabled {
		t.Fatal("mutable local snapshots must not use a stale query cache")
	}
	capabilities := app.services.Backend.Capabilities()
	if capabilities.Collection.Scope != operational.ScopeUnsupported ||
		capabilities.Sessions.Scope != operational.ScopeUnsupported {
		t.Fatal("local snapshot serving advertised collection or OAuth")
	}
	request := func(method, path, body string, authorized bool) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(t.Context(), method, "http://localhost"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if authorized {
			authorize(req)
		}
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		return response
	}
	for _, endpoint := range []string{"/api/readiness", "/api/v1/diagnostics", "/api/repositories"} {
		response := request(http.MethodGet, endpoint, "", true)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", endpoint, response.Code, response.Body.String())
		}
	}
	if response := request(http.MethodPost, "/api/v1/query", `{"sourceNames":["repositories"]}`, false); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized query returned %d", response.Code)
	}
	body := `{"sourceNames":["repositories"],"pagination":{"repositories":{"limit":1}}}`
	response := request(http.MethodPost, "/api/v1/query", body, true)
	var first queryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil || response.Code != http.StatusOK {
		t.Fatalf("query: %d %s %v", response.Code, response.Body.String(), err)
	}
	source := first.Sources["repositories"]
	if len(source.Rows) != 1 || source.ContinuationToken == "" || source.Metadata["total-row-count"] != float64(2) {
		t.Fatalf("missing bounded page: %+v", source)
	}
	next, err := json.Marshal(queryRequest{SourceNames: []string{"repositories"}, Pagination: map[string]paginationRequest{
		"repositories": {Limit: 1, ContinuationToken: source.ContinuationToken},
	}})
	if err != nil {
		t.Fatal(err)
	}
	response = request(http.MethodPost, "/api/v1/query", string(next), true)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"continuationToken"`) {
		t.Fatalf("second page: %d %s", response.Code, response.Body.String())
	}
	index := request(http.MethodGet, "/", "", true)
	if !strings.Contains(index.Body.String(), `name="dashboard-storage-backend" content="sqlite"`) ||
		!strings.Contains(index.Body.String(), `name="dashboard-data-backend" content="server-http"`) {
		t.Fatalf("incorrect server bootstrap: %s", index.Body.String())
	}
	writer, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	events := app.hub.Subscribe(t.Context(), app, false)
	defer app.hub.Unsubscribe(events)
	if _, err := writer.ExecContext(t.Context(), `UPDATE __idb_records SET value=json_set(value,'$.name','updated') WHERE store_name='repositories'`); err != nil {
		t.Fatal(err)
	}
	response = request(http.MethodPost, "/api/v1/query", body, true)
	var updated queryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &updated); err != nil || updated.Revision == first.Revision ||
		updated.Sources["repositories"].Rows[0]["repository"] != "updated" {
		t.Fatalf("query was stale: %s %v", response.Body.String(), err)
	}
	if response = request(http.MethodPost, "/api/v1/query", string(next), true); response.Code == http.StatusOK {
		t.Fatal("stale continuation token was accepted")
	}
	select {
	case event := <-events:
		if event.revision != updated.Revision {
			t.Fatalf("revision subscription was stale: %+v", event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot update did not reach revision subscribers")
	}
	database := app.database
	if err := app.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := database.State(t.Context()); err == nil {
		t.Fatal("owned SQLite database stayed open after Stop")
	}
}

func TestLocalSQLiteMCP(t *testing.T) {
	app, _ := newSQLiteTestApp(t, true)
	httpServer := httptest.NewServer(app.Handler())
	defer httpServer.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "local-sqlite-test", Version: "1"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{token: testAccessToken, base: http.DefaultTransport}},
	}, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Close() }()
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name: "cao_query", Arguments: map[string]any{"id": "campaign-runs", "limit": 10},
	})
	if err != nil || result.IsError {
		t.Fatalf("SQLite MCP query: %+v %v", result, err)
	}
	payload, err := json.Marshal(result.StructuredContent)
	if err != nil || !bytes.Contains(payload, []byte("octo")) {
		t.Fatalf("MCP omitted snapshot data: %s %v", payload, err)
	}
}

func TestLocalSQLiteRejectsHostedAndWriterConfiguration(t *testing.T) {
	for name, config := range map[string]Config{
		"remote":  {Listen: "0.0.0.0:8080"},
		"hosted":  {Listen: "127.0.0.1:8080", HostProfile: hostedHostProfile()},
		"oauth":   {Listen: "127.0.0.1:8080", GitHubOAuth: &GitHubOAuthConfig{}},
		"ingest":  {Listen: "127.0.0.1:8080", SourceDirectory: t.TempDir()},
		"collect": {Listen: "127.0.0.1:8080", Collector: &CollectorConfig{}},
		"webhook": {Listen: "127.0.0.1:8080", WebhookSecret: strings.Repeat("x", 32)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewLocalSQLiteApp(t.Context(), "missing.sqlite", config); err == nil || strings.Contains(err.Error(), "open canonical SQLite") {
				t.Fatalf("unsafe composition reached database opening: %v", err)
			}
		})
	}
}

func TestDashboardQueryCorpusUsesLocalSQLite(t *testing.T) {
	app, _ := newSQLiteTestApp(t, false)
	definitions, parameters, err := dashboardSQLCorpus()
	if err != nil {
		t.Fatal(err)
	}
	if err := bindDashboardSQLCorpusInputs(definitions, parameters); err != nil {
		t.Fatal(err)
	}
	err = app.database.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
		for _, definition := range definitions {
			t.Run(definition.Name, func(t *testing.T) {
				loader := &databaseLoader{ctx: ctx, database: r, app: app, operational: app.services.Cache}
				sources, _, err := loader.ExecuteSQLPlan(definitions, []string{definition.Name}, nil)
				if err != nil {
					t.Fatal(err)
				}
				if _, exists := sources[definition.Name]; !exists {
					t.Fatal("requested source was omitted")
				}
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestLocalSQLiteRejectsInvalidQuery(t *testing.T) {
	app, _ := newSQLiteTestApp(t, false)
	_, _, err := app.executeQuery(t.Context(), queryRequest{
		SourceNames: []string{"invalid"},
		Queries:     []query.Definition{{Name: "invalid", From: "$missing"}},
	}, false)
	if err == nil {
		t.Fatal("unknown source was silently replaced with empty rows")
	}
}
