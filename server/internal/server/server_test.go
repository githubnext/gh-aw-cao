package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/otel"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

const testAccessToken = "0123456789abcdef0123456789abcdef"

func TestValidateListenSafety(t *testing.T) {
	for _, address := range []string{"127.0.0.1:8443", "localhost:8443", "[::1]:8443"} {
		if err := ValidateListen(address, "", ""); err != nil {
			t.Errorf("loopback %s rejected: %v", address, err)
		}
	}
	if err := ValidateListen("0.0.0.0:8443", "cert.pem", "key.pem"); err == nil {
		t.Fatal("expected non-loopback address rejection")
	}
	if err := ValidateListen("127.0.0.1:8443", "cert.pem", ""); err == nil {
		t.Fatal("expected incomplete certificate pair rejection")
	}
}

func TestCapabilityURLUsesConfiguredTransport(t *testing.T) {
	app := &App{config: Config{Listen: "127.0.0.1:8443"}, accessToken: testAccessToken}
	if got := app.capabilityURL(); !strings.HasPrefix(got, "http://") {
		t.Fatalf("local debugging must default to HTTP: %s", got)
	}

	app.config.CertFile = "localhost.pem"
	app.config.KeyFile = "localhost-key.pem"
	if got := app.capabilityURL(); !strings.HasPrefix(got, "https://") {
		t.Fatalf("explicit certificate must enable HTTPS: %s", got)
	}
}

func TestCurrentDashboardQueriesAreAccepted(t *testing.T) {
	definitions, err := ParseDashboardQueries("../../../dashboard/site/dashboard.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := query.Validate(definitions); err != nil {
		t.Fatalf("current dashboard queries are not supported: %v", err)
	}
}

func TestAPINeverReturnsRedisCredentials(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://default:super-secret@" + address + "/0")
	if err != nil {
		t.Fatal(err)
	}
	site, err := os.MkdirTemp(".", ".test-site-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(site); err != nil {
			t.Errorf("remove test site: %v", err)
		}
	})
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(redisx.NewStore(client, "test"), Config{
		Listen: "127.0.0.1:8443", SiteDirectory: site, AccessToken: testAccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://localhost/api/v1/health", nil)
	authorize(request)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	body := response.Body.String()
	for _, forbidden := range []string{"super-secret", "redis://", address} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("API response leaked %q: %s", forbidden, body)
		}
	}
}

func TestAPIResponsesCarryStandardizedTraceIdentifiers(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	t.Cleanup(func() { otel.SetTracerProvider(previousProvider) })
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	shutdown, err := telemetry.Setup(t.Context(), "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 0)
		defer cancel()
		_ = shutdown(ctx)
	})
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	site, err := os.MkdirTemp(".", ".test-site-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(site); err != nil {
			t.Errorf("remove test site: %v", err)
		}
	})
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(redisx.NewStore(client, "test"), Config{
		Listen: "127.0.0.1:8443", SiteDirectory: site, AccessToken: testAccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://localhost/api/v1/health", nil)
	authorize(request)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("health returned %d: %s", response.Code, response.Body.String())
	}
	traceID := response.Header().Get("X-Trace-Id")
	spanID := response.Header().Get("X-Span-Id")
	if len(traceID) != 32 {
		t.Fatalf("expected a 32-character W3C trace id, got %q", traceID)
	}
	if len(spanID) != 16 {
		t.Fatalf("expected a 16-character W3C span id, got %q", spanID)
	}
}

func TestAzureFunctionsHandlerLogsTelemetryFailureOnceAndKeepsServing(t *testing.T) {
	// NewAzureFunctionsHandlerFromEnv is the only caller of azureProcessTelemetry
	// in the process, and this is its only test, so the shared sync.Once
	// has not fired yet; sync.Once cannot be copied/reset, so no
	// save/restore is attempted here.
	previousErr := azureProcessTelemetry.err
	t.Cleanup(func() { azureProcessTelemetry.err = previousErr })

	// An OTLP endpoint plus a malformed OTEL_RESOURCE_ATTRIBUTES value
	// forces telemetry.Setup to fail while building the OpenTelemetry
	// resource, without needing a reachable collector.
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "not-a-valid-key-value-list")
	t.Setenv("CAO_REDIS_URL", "")

	var logOutput strings.Builder
	logger := log.New(&logOutput, "", 0)

	for i := 0; i < 2; i++ {
		_, err := NewAzureFunctionsHandlerFromEnv(t.Context(), t.TempDir(), "", logger)
		if err == nil || !strings.Contains(err.Error(), "CAO_REDIS_URL") {
			t.Fatalf("call %d: expected the missing CAO_REDIS_URL error, got %v", i, err)
		}
	}

	occurrences := strings.Count(logOutput.String(), "telemetry configuration failed")
	if occurrences != 1 {
		t.Fatalf("expected exactly one telemetry failure log line across repeated invocations, got %d: %q", occurrences, logOutput.String())
	}
}

func TestRefreshAndQueryReturnAuthoritativeEvaluatedAt(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	site, err := os.MkdirTemp(".", ".test-site-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(site); err != nil {
			t.Errorf("remove test site: %v", err)
		}
	})
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(redisx.NewStore(client, "test"), Config{
		Listen: "127.0.0.1:8443", SiteDirectory: site, AccessToken: testAccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path string
		body string
	}{
		{path: "/api/v1/refresh", body: ""},
		{path: "/api/v1/query", body: `{"sourceNames":["runs"],"evaluatedAt":"2099-01-01T00:00:00Z"}`},
	} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "https://localhost"+test.path, strings.NewReader(test.body))
		if test.body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		authorize(request)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s returned %d: %s", test.path, response.Code, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), `"evaluatedAt":"2026-02-03T04:05:06Z"`) {
			t.Fatalf("%s did not return authoritative evaluatedAt: %s", test.path, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "2099-01-01") {
			t.Fatalf("%s trusted caller evaluatedAt: %s", test.path, response.Body.String())
		}
	}
}

func TestQueryAllowsEmptyReadinessProbe(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	site, err := os.MkdirTemp(".", ".test-site-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(site); err != nil {
			t.Errorf("remove test site: %v", err)
		}
	})
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(redisx.NewStore(client, "test"), Config{
		Listen: "127.0.0.1:8443", SiteDirectory: site, AccessToken: testAccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		"https://localhost/api/v1/query",
		strings.NewReader(`{"sourceNames":[]}`),
	)
	authorize(request)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("readiness probe returned %d: %s", response.Code, response.Body.String())
	}
	var result struct {
		Revision    int64                   `json:"revision"`
		EvaluatedAt string                  `json:"evaluatedAt"`
		Sources     map[string]model.Source `json:"sources"`
		Metrics     model.Metrics           `json:"metrics"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || result.EvaluatedAt != "2026-02-03T04:05:06Z" {
		t.Fatalf("unexpected readiness metadata: %#v", result)
	}
	if len(result.Sources) != 0 {
		t.Fatalf("readiness probe returned sources: %#v", result.Sources)
	}
	if result.Metrics.DurationMS != 0 || result.Metrics.RedisCommands != 0 || result.Metrics.RedisRows != 0 ||
		len(result.Metrics.PushedDown) != 0 || len(result.Metrics.FallbackOperations) != 0 {
		t.Fatalf("readiness probe returned non-zero metrics: %#v", result.Metrics)
	}
}

func TestStaticIndexInjectsBackendMeta(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, _ := redisx.New("redis://" + address)
	site, err := os.MkdirTemp(".", ".test-site-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(site); err != nil {
			t.Errorf("remove test site: %v", err)
		}
	})
	if err := os.WriteFile(site+"/index.html", []byte("<html><head><title>CAO</title></head><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(redisx.NewStore(client, "test"), Config{
		Listen: "127.0.0.1:8443", SiteDirectory: site, AccessToken: testAccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://localhost/route", nil)
	authorize(request)
	app.Handler().ServeHTTP(response, request)
	if !strings.Contains(response.Body.String(), `<meta name="dashboard-data-backend" content="redis-http">`) {
		t.Fatalf("backend meta was not injected: %s", response.Body.String())
	}
}

func TestCapabilityTokenProtectsStaticAssetsAndAPI(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	site := t.TempDir()
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(redisx.NewStore(client, "test"), Config{
		Listen: "127.0.0.1:8443", SiteDirectory: site, AccessToken: testAccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}

	unauthorizedAPI := httptest.NewRecorder()
	app.Handler().ServeHTTP(
		unauthorizedAPI,
		httptest.NewRequestWithContext(t.Context(), http.MethodPost, "https://localhost/api/v1/refresh", nil),
	)
	if unauthorizedAPI.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized API returned %d", unauthorizedAPI.Code)
	}

	bootstrap := httptest.NewRecorder()
	app.Handler().ServeHTTP(
		bootstrap,
		httptest.NewRequestWithContext(
			t.Context(),
			http.MethodGet,
			"https://localhost/?access_token="+testAccessToken,
			nil,
		),
	)
	if bootstrap.Code != http.StatusOK {
		t.Fatalf("bootstrap returned %d: %s", bootstrap.Code, bootstrap.Body.String())
	}
	if len(bootstrap.Result().Cookies()) != 0 {
		t.Fatal("bootstrap must not place the bearer capability in a cookie")
	}
	if !strings.Contains(bootstrap.Body.String(), `localStorage.setItem("cao-dashboard-access-token"`) {
		t.Fatalf("bootstrap did not initialize origin-scoped storage: %s", bootstrap.Body.String())
	}
	if !strings.Contains(bootstrap.Body.String(), `history.replaceState`) ||
		strings.Contains(bootstrap.Body.String(), `location.replace`) {
		t.Fatalf("bootstrap must remove the token without navigation: %s", bootstrap.Body.String())
	}

	authorizedAPI := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "https://localhost/api/v1/refresh", nil)
	authorize(request)
	app.Handler().ServeHTTP(authorizedAPI, request)
	if authorizedAPI.Code != http.StatusOK {
		t.Fatalf("authorized API returned %d: %s", authorizedAPI.Code, authorizedAPI.Body.String())
	}

	invalidHost := httptest.NewRecorder()
	request = httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://attacker.example/", nil)
	request.Host = "attacker.example"
	authorize(request)
	app.Handler().ServeHTTP(invalidHost, request)
	if invalidHost.Code != http.StatusMisdirectedRequest {
		t.Fatalf("invalid host returned %d", invalidHost.Code)
	}
}

func authorize(request *http.Request) {
	request.Header.Set("Authorization", "Bearer "+testAccessToken)
}

func fakeRedis(t *testing.T) (string, func()) {
	t.Helper()
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	values := map[string]string{}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() {
					_ = connection.Close()
				}()
				reader := bufio.NewReader(connection)
				command, err := readCommand(reader)
				if err != nil {
					return
				}
				if len(command) > 0 && command[0] == "AUTH" {
					_, _ = fmt.Fprint(connection, "+OK\r\n")
					command, err = readCommand(reader)
					if err != nil {
						return
					}
				}
				switch command[0] {
				case "PING":
					_, _ = fmt.Fprint(connection, "+PONG\r\n")
				case "FT._LIST":
					_, _ = fmt.Fprint(connection, "*0\r\n")
				case "SET":
					mu.Lock()
					values[command[1]] = command[2]
					mu.Unlock()
					_, _ = fmt.Fprint(connection, "+OK\r\n")
				case "GET":
					mu.Lock()
					value, ok := values[command[1]]
					mu.Unlock()
					if !ok {
						_, _ = fmt.Fprint(connection, "$-1\r\n")
					} else {
						_, _ = fmt.Fprintf(connection, "$%d\r\n%s\r\n", len(value), value)
					}
				case "DEL":
					mu.Lock()
					_, ok := values[command[1]]
					delete(values, command[1])
					mu.Unlock()
					if ok {
						_, _ = fmt.Fprint(connection, ":1\r\n")
					} else {
						_, _ = fmt.Fprint(connection, ":0\r\n")
					}
				case "HGETALL":
					_, _ = fmt.Fprint(connection, "*10\r\n$10\r\ngeneration\r\n$2\r\ng1\r\n$8\r\nrevision\r\n$1\r\n1\r\n$6\r\ncounts\r\n$2\r\n{}\r\n$11\r\nactivatedAt\r\n$20\r\n2026-01-01T00:00:00Z\r\n$11\r\nevaluatedAt\r\n$20\r\n2026-02-03T04:05:06Z\r\n")
				case "HMGET":
					_, _ = fmt.Fprint(connection, "*3\r\n$28\r\n{\"availability\":\"available\"}\r\n$2\r\n{}\r\n$2\r\n{}\r\n")
				case "SMEMBERS":
					_, _ = fmt.Fprint(connection, "*0\r\n")
				default:
					_, _ = fmt.Fprint(connection, "-ERR unsupported\r\n")
				}
			}()
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	return listener.Addr().String(), func() {
		cancel()
		_ = listener.Close()
	}
}

func readCommand(reader *bufio.Reader) ([]string, error) {
	var count int
	if _, err := fmt.Fscanf(reader, "*%d\r\n", &count); err != nil {
		return nil, err
	}
	command := make([]string, count)
	for i := range command {
		var length int
		if _, err := fmt.Fscanf(reader, "$%d\r\n", &length); err != nil {
			return nil, err
		}
		value := make([]byte, length+2)
		if _, err := reader.Read(value); err != nil {
			return nil, err
		}
		command[i] = string(value[:length])
	}
	return command, nil
}
