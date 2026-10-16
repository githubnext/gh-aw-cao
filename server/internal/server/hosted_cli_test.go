package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/hostedcli"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type hostedCLITestQueue struct {
	mutex    sync.Mutex
	commands map[int64]*operational.CLICommand
	output   map[int64][]operational.CLICommandOutput
	next     int64
}

var _ operational.CLICommandQueue = (*hostedCLITestQueue)(nil)

func newHostedCLITestQueue() *hostedCLITestQueue {
	return &hostedCLITestQueue{commands: map[int64]*operational.CLICommand{}, output: map[int64][]operational.CLICommandOutput{}}
}

func (q *hostedCLITestQueue) Acquire(context.Context, string, time.Duration) (operational.CLICommandLease, error) {
	return operational.CLICommandLease{}, nil
}
func (q *hostedCLITestQueue) Renew(_ context.Context, lease operational.CLICommandLease, _ time.Duration) (operational.CLICommandLease, error) {
	return lease, nil
}
func (q *hostedCLITestQueue) Release(context.Context, operational.CLICommandLease) error { return nil }
func (q *hostedCLITestQueue) AcknowledgeRecovery(context.Context, operational.CLICommandLease) error {
	return nil
}
func (q *hostedCLITestQueue) Enqueue(_ context.Context, invocation operational.CLICommandInvocation, key string, retryOf int64) (operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	q.next++
	command := &operational.CLICommand{
		CLICommandInvocation: invocation, ID: q.next, Status: operational.CLICommandQueued,
		CreatedAt: time.Unix(1700000000, 0), IdempotencyKey: key, RetryOf: retryOf,
	}
	q.commands[command.ID] = command
	return *command, nil
}
func (q *hostedCLITestQueue) Claim(context.Context, operational.CLICommandLease) (*operational.CLICommand, error) {
	return nil, nil
}
func (q *hostedCLITestQueue) Finish(context.Context, operational.CLICommandLease, int64, operational.CLICommandResult) error {
	return nil
}
func (q *hostedCLITestQueue) AppendOutput(context.Context, operational.CLICommandLease, int64, string, string) (operational.CLICommandOutput, error) {
	return operational.CLICommandOutput{}, nil
}
func (q *hostedCLITestQueue) Settle(context.Context, operational.CLICommandLease, int64, *int) error {
	return nil
}
func (q *hostedCLITestQueue) Cancel(_ context.Context, id int64) (operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	command, ok := q.commands[id]
	if !ok {
		return operational.CLICommand{}, operational.ErrCLICommandNotFound
	}
	if !command.Status.Terminal() {
		command.Status = operational.CLICommandCanceled
	}
	return *command, nil
}
func (q *hostedCLITestQueue) Detail(_ context.Context, id int64) (operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	command, ok := q.commands[id]
	if !ok {
		return operational.CLICommand{}, operational.ErrCLICommandNotFound
	}
	return *command, nil
}
func (q *hostedCLITestQueue) List(context.Context, operational.CLICommandFilter) (operational.CLICommandPage, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	page := operational.CLICommandPage{}
	for id := int64(1); id <= q.next; id++ {
		if command, ok := q.commands[id]; ok {
			page.Commands = append(page.Commands, *command)
		}
	}
	page.Total = len(page.Commands)
	return page, nil
}
func (q *hostedCLITestQueue) Output(_ context.Context, id, after int64, limit int) ([]operational.CLICommandOutput, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	var chunks []operational.CLICommandOutput
	for _, chunk := range q.output[id] {
		if chunk.Sequence > after && len(chunks) < limit {
			chunks = append(chunks, chunk)
		}
	}
	return chunks, nil
}
func (q *hostedCLITestQueue) Retain(context.Context) (int64, error) { return 0, nil }

type hostedCLIFixture struct {
	app     *App
	queue   *hostedCLITestQueue
	session *http.Cookie
	csrf    *http.Cookie
	push    bool
	mutex   sync.Mutex
	probes  []string
}

// newHostedCLIFixture serves the OAuth fake and answers repository
// permission lookups made with the requester's OAuth token.
func newHostedCLIFixture(t *testing.T, admins []string) *hostedCLIFixture {
	t.Helper()
	fixture := &hostedCLIFixture{queue: newHostedCLITestQueue(), push: true}
	oauthServer := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	target, err := url.Parse(oauthServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/repos/") {
			fixture.mutex.Lock()
			fixture.probes = append(fixture.probes, request.URL.Path+" "+request.Header.Get("Authorization"))
			push := fixture.push
			fixture.mutex.Unlock()
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(map[string]any{"permissions": map[string]bool{"push": push}})
			return
		}
		proxy.ServeHTTP(response, request)
	}))
	t.Cleanup(github.Close)
	fixture.app = memoryOAuthApp(t, github.URL)
	fixture.app.config.AdminUsers = admins
	catalog, err := hostedcli.LoadCatalog(filepath.Join("..", "..", "..", "dashboard", "site", "dashboard.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.app.EnableHostedCLIActions(t.Context(), HostedCLIConfig{
		Catalog: catalog, ControlRepository: "octo/cao", GitHubURL: "https://github.com",
		DashboardURL: "https://dashboard.example.com/", Queue: fixture.queue,
	}); err != nil {
		t.Fatal(err)
	}
	fixture.session, fixture.csrf = callbackSession(t, fixture.app)
	return fixture
}

func (f *hostedCLIFixture) do(t *testing.T, method, path, body string, csrf bool) *httptest.ResponseRecorder {
	t.Helper()
	request := azureRequest(t, method, path)
	if body != "" {
		request = httptest.NewRequestWithContext(t.Context(), method, "https://dashboard.example.com"+path, strings.NewReader(body))
		request.Host = "dashboard.example.com"
		request.Header.Set("X-Forwarded-Host", "dashboard.example.com")
		request.Header.Set("X-Forwarded-Proto", "https")
		request.Header.Set("Content-Type", "application/json")
	}
	request.AddCookie(f.session)
	request.AddCookie(f.csrf)
	if csrf {
		request.Header.Set("X-CSRF-Token", f.csrf.Value)
	}
	response := httptest.NewRecorder()
	f.app.Handler().ServeHTTP(response, request)
	return response
}

const hostedUpgradeRequest = `{"id":"upgrade-target-repository","values":{"repository":"octo/app"},"arguments":{}}`

func TestHostedCLIActionsAreDisabledByDefault(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := memoryOAuthApp(t, github.URL)
	app.config.AdminUsers = []string{"octocat"}
	session, csrf := callbackSession(t, app)
	request := azureRequest(t, http.MethodPost, "/__cli_commands")
	request.AddCookie(session)
	request.AddCookie(csrf)
	request.Header.Set("X-CSRF-Token", csrf.Value)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code == http.StatusAccepted || response.Code == http.StatusOK {
		t.Fatalf("disabled hosted CLI accepted a command: %d", response.Code)
	}
}

func TestHostedCLIEnableRequiresOAuthAndControlRepository(t *testing.T) {
	catalog, err := hostedcli.ParseCatalog([]byte(`{"dashboard":{"cli-actions":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := (&App{}).EnableHostedCLIActions(t.Context(), HostedCLIConfig{Catalog: catalog, ControlRepository: "octo/cao"}); err == nil {
		t.Fatal("hosted CLI actions enabled without OAuth")
	}
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := memoryOAuthApp(t, github.URL)
	if err := app.EnableHostedCLIActions(t.Context(), HostedCLIConfig{Catalog: catalog, ControlRepository: "../x", Queue: newHostedCLITestQueue()}); err == nil {
		t.Fatal("hosted CLI actions accepted an invalid control repository")
	}
}

func TestHostedCLIEnqueueRecordsActorAndRepository(t *testing.T) {
	fixture := newHostedCLIFixture(t, []string{"OctoCat"})
	response := fixture.do(t, http.MethodPost, "/__cli_commands", hostedUpgradeRequest, true)
	if response.Code != http.StatusAccepted {
		t.Fatalf("enqueue = %d: %s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["actor"] != "octocat" || payload["repository"] != "octo/app" || payload["status"] != "queued" {
		t.Fatalf("unexpected command %v", payload)
	}
	if len(fixture.probes) != 1 || !strings.HasPrefix(fixture.probes[0], "/repos/octo/app ") ||
		!strings.Contains(fixture.probes[0], "Bearer ") {
		t.Fatalf("requester permission was not checked with the OAuth token: %v", fixture.probes)
	}
	if strings.Contains(response.Body.String(), "access-token") {
		t.Fatal("response exposed an OAuth token")
	}
}

func TestHostedCLIAdmissionFailsClosed(t *testing.T) {
	t.Run("non-admin", func(t *testing.T) {
		fixture := newHostedCLIFixture(t, []string{"someone-else"})
		if response := fixture.do(t, http.MethodPost, "/__cli_commands", hostedUpgradeRequest, true); response.Code != http.StatusForbidden {
			t.Fatalf("non-admin enqueue = %d", response.Code)
		}
		if response := fixture.do(t, http.MethodGet, "/__cli_commands", "", false); response.Code != http.StatusForbidden {
			t.Fatalf("non-admin list = %d", response.Code)
		}
	})
	t.Run("missing CSRF", func(t *testing.T) {
		fixture := newHostedCLIFixture(t, []string{"octocat"})
		if response := fixture.do(t, http.MethodPost, "/__cli_commands", hostedUpgradeRequest, false); response.Code != http.StatusForbidden {
			t.Fatalf("enqueue without CSRF = %d", response.Code)
		}
	})
	t.Run("no write permission", func(t *testing.T) {
		fixture := newHostedCLIFixture(t, []string{"octocat"})
		fixture.push = false
		if response := fixture.do(t, http.MethodPost, "/__cli_commands", hostedUpgradeRequest, true); response.Code != http.StatusForbidden {
			t.Fatalf("enqueue without push = %d", response.Code)
		}
		if len(fixture.queue.commands) != 0 {
			t.Fatal("unauthorized command was queued")
		}
	})
	t.Run("undeclared action", func(t *testing.T) {
		fixture := newHostedCLIFixture(t, []string{"octocat"})
		response := fixture.do(t, http.MethodPost, "/__cli_commands", `{"id":"no-such-action"}`, true)
		if response.Code < 400 || response.Code >= 500 {
			t.Fatalf("undeclared action = %d", response.Code)
		}
	})
	t.Run("unknown fields", func(t *testing.T) {
		fixture := newHostedCLIFixture(t, []string{"octocat"})
		response := fixture.do(t, http.MethodPost, "/__cli_commands", `{"id":"upgrade-target-repository","command":"rm -rf /"}`, true)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("unknown field = %d", response.Code)
		}
	})
}

func TestHostedCLIListDetailCancelAndOutput(t *testing.T) {
	fixture := newHostedCLIFixture(t, []string{"octocat"})
	if response := fixture.do(t, http.MethodPost, "/__cli_commands", hostedUpgradeRequest, true); response.Code != http.StatusAccepted {
		t.Fatalf("enqueue = %d: %s", response.Code, response.Body.String())
	}
	list := fixture.do(t, http.MethodGet, "/__cli_commands?limit=10", "", false)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"repository":"octo/app"`) {
		t.Fatalf("list = %d: %s", list.Code, list.Body.String())
	}
	if response := fixture.do(t, http.MethodGet, "/__cli_commands/1", "", false); response.Code != http.StatusOK {
		t.Fatalf("detail = %d", response.Code)
	}
	if response := fixture.do(t, http.MethodGet, "/__cli_commands/99", "", false); response.Code != http.StatusNotFound {
		t.Fatalf("missing detail = %d", response.Code)
	}
	if response := fixture.do(t, http.MethodPost, "/__cli_commands/1/retry", `{}`, true); response.Code != http.StatusConflict {
		t.Fatalf("retry of queued command = %d", response.Code)
	}
	cancel := fixture.do(t, http.MethodPost, "/__cli_commands/1/cancel", `{}`, true)
	if cancel.Code != http.StatusOK || !strings.Contains(cancel.Body.String(), `"status":"canceled"`) {
		t.Fatalf("cancel = %d: %s", cancel.Code, cancel.Body.String())
	}
	fixture.queue.output[1] = []operational.CLICommandOutput{{Sequence: 1, Stream: "stdout", Data: "hello\n"}}
	output := fixture.do(t, http.MethodGet, "/__cli_commands/1/output", "", false)
	if output.Code != http.StatusOK {
		t.Fatalf("output = %d", output.Code)
	}
	var types []string
	scanner := bufio.NewScanner(strings.NewReader(output.Body.String()))
	for scanner.Scan() {
		var event map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		types = append(types, event["type"].(string))
	}
	if strings.Join(types, ",") != "output,complete" {
		t.Fatalf("output events = %v", types)
	}
}

func TestHostedCLIIndexAdvertisesQueueOnlyWhenEnabled(t *testing.T) {
	fixture := newHostedCLIFixture(t, []string{"octocat"})
	if err := os.WriteFile(filepath.Join(fixture.app.config.SiteDirectory, "index.html"), []byte("<html><head></head></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := fixture.do(t, http.MethodGet, "/", "", false)
	if !strings.Contains(response.Body.String(), "__CLI_QUEUE__ = true") {
		t.Fatalf("enabled index does not advertise the queue: %d %s", response.Code, response.Body.String())
	}
	fixture.app.hostedCLI = nil
	response = fixture.do(t, http.MethodGet, "/", "", false)
	if strings.Contains(response.Body.String(), "__CLI_QUEUE__") {
		t.Fatal("disabled index advertised the queue")
	}
}

func TestHostedCLIConfigEnvironment(t *testing.T) {
	t.Setenv("CAO_HOSTED_CLI_CONTROL_REPOSITORY", "")
	t.Setenv("CAO_COLLECT_CONTROL_REPOSITORY", "octo/cao")
	t.Setenv("CAO_HOSTED_CLI_DASHBOARD_URL", "")
	t.Setenv("CAO_GITHUB_REDIRECT_URL", "https://dashboard.example.com/auth/callback")
	config, err := HostedCLIConfigFromEnv(filepath.Join("..", "..", "..", "dashboard", "site", "dashboard.json"))
	if err != nil {
		t.Fatal(err)
	}
	if config.ControlRepository != "octo/cao" || config.DashboardURL != "https://dashboard.example.com/" {
		t.Fatalf("unexpected config %+v", config)
	}
	for apiURL, want := range map[string]string{
		"": "github.com", "https://api.github.com": "github.com",
		"https://api.octo.ghe.com": "octo.ghe.com", "https://ghes.example.com/api/v3": "ghes.example.com",
	} {
		if got, err := gitHubHost(apiURL); err != nil || got != want {
			t.Fatalf("gitHubHost(%q) = %q, %v", apiURL, got, err)
		}
	}
	if _, err := gitHubHost("http://ghes.example.com"); err == nil {
		t.Fatal("plaintext GitHub API accepted")
	}
}

func TestHostedCLIExecutorRequiresDedicatedApp(t *testing.T) {
	t.Setenv("CAO_HOSTED_CLI_APP_ID", "")
	if _, err := NewHostedCLIExecutorFromEnv(t.Context(), HostedCLIExecutorOptions{}); err == nil ||
		!strings.Contains(err.Error(), "CAO_HOSTED_CLI_APP_ID") {
		t.Fatalf("executor started without a dedicated App: %v", err)
	}
}
