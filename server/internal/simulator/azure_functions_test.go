package simulator

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The successful deployment uses the reviewed build context and real Functions
// process. Only Azure's resource/control APIs and public ingress are simulated.
type setupAzureFunctions struct {
	ctx                            context.Context
	directory, source, binary, dsn string
	proxy, ca                      string
	env                            []string
	handler                        http.Handler
	client                         *http.Client
	address                        string
	process                        *exec.Cmd
	done                           chan error
}

func newSetupAzureFunctions(t *testing.T, ctx context.Context) *setupAzureFunctions {
	t.Helper()
	rawEndpoint := os.Getenv("POSTGRES_URL")
	config, err := setupAzureFunctionsPostgresConfig(rawEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal("connect to local PostgreSQL: ", err)
	}
	schema := "cao_functions_" + strings.ToLower(rand.Text())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_, err := admin.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		if err != nil {
			t.Error(err)
		}
		_ = admin.Close(cleanup)
	})
	endpoint, err := url.Parse(rawEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	query := endpoint.Query()
	query.Set("search_path", schema)
	endpoint.RawQuery = query.Encode()
	directory := t.TempDir()
	f := &setupAzureFunctions{ctx: ctx, directory: directory, binary: filepath.Join(directory, "cao-dashboard"), dsn: endpoint.String()}
	t.Cleanup(func() {
		if err := f.stop(); err != nil {
			t.Error(err)
		}
		if f.client != nil {
			f.client.CloseIdleConnections()
		}
	})
	return f
}

func setupAzureFunctionsPostgresConfig(raw string) (*pgx.ConnConfig, error) {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme != "postgres" && endpoint.Scheme != "postgresql" ||
		net.ParseIP(endpoint.Hostname()) == nil || !net.ParseIP(endpoint.Hostname()).IsLoopback() {
		return nil, errors.New("Azure Functions integration requires POSTGRES_URL with a numeric-loopback PostgreSQL instance")
	}
	config, err := pgx.ParseConfig(raw)
	if err != nil {
		return nil, errors.New("Azure Functions integration requires a valid PostgreSQL connection URL")
	}
	hosts := []string{config.Host}
	for _, fallback := range config.Fallbacks {
		hosts = append(hosts, fallback.Host)
	}
	for _, host := range hosts {
		if !net.ParseIP(host).IsLoopback() {
			return nil, errors.New("Azure Functions integration requires every PostgreSQL connection host to be numeric loopback")
		}
	}
	return config, nil
}

func TestSetupAzureFunctionsPostgresConfig(t *testing.T) {
	for _, test := range []struct {
		name, endpoint string
		allowed        bool
	}{
		{"IPv4 loopback", "postgres://test@127.0.0.1/cao", true},
		{"IPv6 loopback", "postgres://test@[::1]/cao", true},
		{"remote authority", "postgres://test@192.0.2.1/cao", false},
		{"hostname", "postgres://test@localhost/cao", false},
		{"remote query override", "postgres://test@127.0.0.1/cao?host=192.0.2.1", false},
		{"remote fallback", "postgres://test@127.0.0.1/cao?host=127.0.0.1,192.0.2.1", false},
		{"socket query override", "postgres://test@127.0.0.1/cao?host=%2Ftmp", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := setupAzureFunctionsPostgresConfig(test.endpoint)
			if (err == nil) != test.allowed {
				t.Fatalf("endpoint allowed = %t, want %t", err == nil, test.allowed)
			}
		})
	}
}

func (f *setupAzureFunctions) build(source string) error {
	root, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	dockerfile, err := root.ReadFile("server/Dockerfile")
	if err != nil {
		return err
	}
	_, runtime, ok := strings.Cut(string(dockerfile), " AS azure-functions-runtime\n")
	runtime, _, _ = strings.Cut(runtime, "\nFROM ")
	if !ok || !strings.Contains(runtime, `ENTRYPOINT ["/app/cao-dashboard"]`) ||
		!strings.Contains(runtime, `CMD ["azure-functions"]`) {
		return errors.New("Functions image must launch cao-dashboard azure-functions")
	}
	f.source = source
	queries, err := root.ReadFile("dashboard/site/src/data/queries/database.json")
	if err != nil {
		return err
	}
	queryPath := filepath.Join(f.directory, "database-queries.json")
	if err := os.WriteFile(queryPath, queries, 0o600); err != nil { // #nosec G703 -- fixed test-owned durable image input.
		return err
	}
	command := exec.CommandContext(f.ctx, "go", "build", "-mod=readonly", "-o", f.binary, "./cmd/cao-dashboard") // #nosec G204,G702 -- fixed build command in the exact isolated ACR context.
	command.Dir = filepath.Join(source, "server")
	command.Env = setupAzureEnvironment(setupAzureToolEnvironment("PATH", "HOME", "TMPDIR", "GOPATH", "GOMODCACHE", "GOCACHE", "CGO_ENABLED", "SDKROOT", "DEVELOPER_DIR"),
		map[string]string{"GOTOOLCHAIN": "local", "GOPROXY": "off", "GOSUMDB": "off", "GOVCS": "*:off", "GOENV": "off"})
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("build Functions command from ACR context: %w\n%s", err, output)
	}
	site := filepath.Join(f.directory, "site")
	if err := os.Mkdir(site, 0o700); err != nil { // #nosec G703 -- fixed child of t.TempDir, not an Azure argument.
		return err
	}
	if err := os.WriteFile(filepath.Join(site, "index.html"), []byte("<html><head></head><body>Functions lifecycle fixture</body></html>"), 0o600); err != nil { // #nosec G703 -- fixed child of t.TempDir.
		return err
	}
	f.env = setupAzureEnvironment(setupAzureToolEnvironment("PATH", "HOME", "TMPDIR"), map[string]string{
		"OTEL_SDK_DISABLED": "true", "CAO_POSTGRES_URL": f.dsn,
		// Snapshot refresh assertions need fresh reads, not the production
		// five-minute query cache admitted when CI queries exceed 100 ms.
		"CAO_QUERY_CACHE_DISABLED":    "true",
		"DEBUG":                       "cao:functions:startup",
		"CAO_POLICY_PATH":             filepath.Join(source, ".github/workflows/cao.azure.json"),
		"CAO_DATABASE_QUERIES":        queryPath,
		"CAO_AZURE_DASHBOARD_QUERIES": filepath.Join(source, "dashboard/site/dashboard.json"),
		"CAO_AZURE_SITE_DIRECTORY":    site, "CAO_AZURE_ALLOWED_HOSTS": setupAzureHost,
		"REDIS_NAMESPACE": "azure-dashboard", "CAO_OPERATIONAL_NAMESPACE": "azure-dashboard-operational",
		"CAO_GITHUB_CLIENT_ID": "Iv1.caosetupsim", "CAO_GITHUB_CLIENT_SECRET": setupAzureSecrets()["CAO_SIM_CLIENT_SECRET"],
		"CAO_SESSION_SECRET":      setupAzureSecrets()["CAO_SIM_SESSION_SECRET"],
		"CAO_GITHUB_ALLOWED_ORGS": "platform", "CAO_GITHUB_REDIRECT_URL": "https://" + setupAzureHost + "/auth/callback",
		"HTTPS_PROXY": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1",
	})
	if f.proxy != "" {
		f.env = setupAzureEnvironment(f.env, map[string]string{
			"HTTPS_PROXY": f.proxy, "HTTP_PROXY": f.proxy, "SSL_CERT_FILE": f.ca,
			"NO_PROXY": "", "no_proxy": "",
		})
	}
	return nil
}

func (f *setupAzureFunctions) runJob(job string) error {
	var commands [][]string
	env := f.env
	if job == setupAzureApp+"-db-provision" {
		env = setupAzureEnvironment(env, map[string]string{"CAO_DATABASE_ADMIN_URL": f.dsn})
		commands = [][]string{
			{"database", "bootstrap", "--store", "canonical", "--namespace", "azure-dashboard"},
			{"database", "bootstrap", "--store", "operational", "--namespace", "azure-dashboard-operational"},
		}
	} else {
		source := filepath.Join(f.source, "server/azure/empty-data")
		if _, err := os.Stat(filepath.Join(f.source, "cao-deploy-evidence")); err == nil { // #nosec G703 -- fixed child of the isolated reviewed ACR context.
			source = filepath.Join(f.source, "cao-deploy-evidence")
		} else if !os.IsNotExist(err) {
			return err
		}
		commands = [][]string{{"ingest", "--source", source, "--redis-namespace", "azure-dashboard",
			"--database-queries", filepath.Join(f.directory, "database-queries.json")}}
	}
	for _, args := range commands {
		command := exec.CommandContext(f.ctx, f.binary, args...) // #nosec G204,G702 -- test-built binary and fixed provisioning/ingestion arguments.
		command.Dir, command.Env = f.directory, env
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("Functions deployment job: %w\n%s", err, output)
		}
	}
	return nil
}

func (f *setupAzureFunctions) start(ctx context.Context) error {
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0") // #nosec G102 -- numeric loopback only.
	if err != nil {
		return err
	}
	f.address = listener.Addr().String()
	_ = listener.Close()
	_, port, err := net.SplitHostPort(f.address)
	if err != nil {
		return err
	}
	target, err := url.Parse("http://" + f.address)
	if err != nil {
		return err
	}
	transport, err := NewLocalTransport(target.String())
	if err != nil {
		return err
	}
	f.client = &http.Client{Transport: transport, Timeout: time.Second}
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = setupAzureHost
			r.Out.Header.Set("X-Forwarded-Host", setupAzureHost)
			r.Out.Header.Set("X-Forwarded-Proto", "https")
		},
	}
	f.handler = proxy
	//nolint:contextcheck // The process belongs to the test lifetime, not the single Azure restart request.
	command := exec.CommandContext(f.ctx, f.binary, "azure-functions") // #nosec G204 -- binary compiled from the materialized ACR context.
	command.Dir = f.directory
	command.Env = setupAzureEnvironment(f.env, map[string]string{"FUNCTIONS_CUSTOMHANDLER_HOST": "127.0.0.1", "FUNCTIONS_CUSTOMHANDLER_PORT": port})
	log, err := os.OpenFile(filepath.Join(f.directory, "functions.log"), os.O_CREATE|os.O_WRONLY, 0o600) // #nosec G304 -- fixed test-owned log.
	if err != nil {
		return err
	}
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		_ = log.Close()
		return err
	}
	f.process, f.done = command, make(chan error, 1)
	go func() {
		f.done <- command.Wait()
		_ = log.Close()
	}()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String()+"/api/readiness", nil)
		if err != nil {
			return err
		}
		request.Header.Set("X-Forwarded-Host", setupAzureHost)
		request.Header.Set("X-Forwarded-Proto", "https")
		response, err := f.client.Do(request) // #nosec G704 -- exact numeric-loopback transport.
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case err := <-f.done:
			f.process = nil
			return fmt.Errorf("Functions process exited before readiness: %w", err)
		case <-ctx.Done():
			return errors.New("Functions process did not become ready")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (f *setupAzureFunctions) stop() error {
	if f.process == nil {
		return nil
	}
	if err := f.process.Process.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	select {
	case err := <-f.done:
		f.process = nil
		return err
	case <-time.After(10 * time.Second):
		_ = f.process.Process.Kill()
		<-f.done
		f.process = nil
		return errors.New("Functions process did not gracefully exit after SIGTERM")
	}
}

func (f *setupAzureFunctions) assertShutdown(t *testing.T, ctx context.Context) {
	t.Helper()
	if f.process == nil {
		t.Fatal("Azure deployment did not start the Functions command")
	}
	if err := f.stop(); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+f.address+"/api/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	if response, err := f.client.Do(request); err == nil { // #nosec G704 -- exact numeric-loopback transport.
		_ = response.Body.Close()
		t.Fatal("Functions listener still accepts requests after shutdown")
	}
	content := setupRead(t, filepath.Join(f.directory, "functions.log"))
	assertSetupAzureNoSecrets(t, content)
	if !bytes.Contains(content, []byte("cao:functions:startup listening addr=")) {
		t.Fatal("Functions startup logging is required to verify shutdown failures")
	}
	if bytes.Contains(content, []byte("shutdown failed")) {
		t.Fatal("Functions shutdown did not drain HTTP and telemetry cleanly")
	}
	t.Log("cao-dashboard azure-functions built from the ACR context, served Azure receipt checks against PostgreSQL, and exited successfully on SIGTERM")
}
