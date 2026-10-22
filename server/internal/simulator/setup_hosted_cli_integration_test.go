package simulator

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The real gh, installed extension, App JWTs and browser manifest exchange all
// use the strict CONNECT simulator. No Node runtime or live GitHub authority exists.
func TestCAOHostedCLISetupIntegration(t *testing.T) {
	if os.Getenv("CAO_SETUP_INTEGRATION") != "1" {
		t.Skip("run npm run test:integration:setup to exercise native hosted App setup")
	}
	catalog, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	binary := filepath.Join(root, "gh-cao")
	bootstrapRun(t, ctx, catalog, nil, "go", "build", "-mod=readonly", "-o", binary, "./cmd/gh-cao")
	for _, test := range []struct {
		name, failure string
		flags         []string
	}{
		{name: "create and add explicit targets"},
		{name: "repository admin denied uses browser"},
		{name: "successful addition missing membership", failure: "does not cover every requested repository"},
		{name: "all-repository installation", failure: "installed for all repositories"},
		{name: "extra App permission", failure: "unsupported permission"},
		{name: "installation API denied", failure: "HTTP 403"},
		{name: "invalid callback state", failure: "invalid GitHub App manifest callback code or state"},
		{name: "manifest conversion denied", failure: "manifest conversion failed"},
		{name: "cross-owner refused", flags: []string{"--target-repository", "other/app"}, failure: "cannot be installed on other"},
		{name: "existing key file refused", failure: "reserve private-key bootstrap file"},
		{name: "offline dry run", flags: []string{"--dry-run"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			f := newSetupFixture(t, ctx, root, catalog, binary, nil)
			setupGitHubAppNativePath(t, f)
			setupWrite(t, f.policyPath(), []byte(`{"version":1,"control-plane":{"scope":{"allowed-repositories":["other/app"]},"defaults":{"mode":"review"},"campaigns":{}}}`))
			beforePolicy, beforeState := setupRead(t, f.policyPath()), f.state(t)
			tree := setupCheckoutState(t, f.checkout)
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			app := &setupHostedAppAPI{
				t: t, base: f.api, key: key, scenario: test.name,
				pem: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})),
			}
			f.setHandler(func(w http.ResponseWriter, r *http.Request) bool {
				app.ServeHTTP(w, r)
				return true
			})
			keyPath := filepath.Join(f.root, "bootstrap.pem")
			if test.name == "existing key file refused" {
				setupWrite(t, keyPath, []byte("keep existing bootstrap"))
			}
			client := setupHostedBrowserClient(t, f.env)
			defer client.CloseIdleConnections()
			command := exec.CommandContext(ctx, "gh", append([]string{
				"cao", "setup", "auth", "hosted-cli", "--repo", "platform/control",
				"--target-repository", "platform/zeta", "--target-repository", "platform/alpha",
				"--target-repository", "platform/alpha", "--app-name", "approved-hosted-app",
				"--private-key-out", keyPath, "--no-open",
			}, test.flags...)...) // #nosec G204 -- fixed gh binary, isolated PATH, test-owned arguments and strict CONNECT proxy.
			command.Dir, command.Env = f.checkout, f.env
			var stdout, stderr bytes.Buffer
			command.Stdout = &stdout
			pipe, err := command.StderrPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			scanner := bufio.NewScanner(pipe)
			for scanner.Scan() {
				line := scanner.Text()
				stderr.WriteString(line + "\n")
				if address, ok := strings.CutPrefix(line, "Open this URL to continue: "); ok {
					switch {
					case strings.HasPrefix(address, "http://127.0.0.1:"):
						setupHostedApproveManifest(t, ctx, client, address, test.name)
					case address == "https://github.com/organizations/platform/settings/installations/456":
						setupHostedApproveInstallation(t, ctx, client, address, "selected", []string{"platform/control", "platform/alpha", "platform/zeta"})
					default:
						t.Fatalf("unexpected browser approval destination: %s", address)
					}
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			err = command.Wait()
			if (err == nil) != (test.failure == "") || (err != nil && !strings.Contains(stderr.String(), test.failure)) {
				t.Fatalf("want failure %q, got %v\nstdout: %s\nstderr: %s", test.failure, err, &stdout, &stderr)
			}
			if strings.Contains(stdout.String()+stderr.String(), app.pem) || strings.Contains(stdout.String()+stderr.String(), "simulator-installation-token") {
				t.Fatal("setup exposed private key or installation token")
			}
			app.mu.Lock()
			converted, installed, additions := app.converted, app.installed, slices.Clone(app.additions)
			selected, requests := slices.Clone(app.selected), slices.Clone(app.requests)
			app.mu.Unlock()
			if test.name == "offline dry run" {
				var plan map[string]any
				if err := json.Unmarshal(stdout.Bytes(), &plan); err != nil {
					t.Fatal(err)
				}
				setupAssertJSON(t, plan["installationTargets"], []map[string]any{{"owner": "platform", "repositories": []string{"alpha", "control", "zeta"}}})
				setupAssertJSON(t, plan["manifest"].(map[string]any)["default_permissions"], setupHostedPermissions())
			}
			data, readErr := os.ReadFile(keyPath) // #nosec G304,G703 -- exact test-owned bootstrap file.
			switch {
			case test.name == "existing key file refused":
				if readErr != nil || string(data) != "keep existing bootstrap" {
					t.Fatal("existing key file was overwritten")
				}
			case converted:
				if readErr != nil || string(data) != app.pem {
					t.Fatal("downloaded key missing after setup or failed verification")
				}
				info, err := os.Stat(keyPath)
				if err != nil || info.Mode().Perm() != 0o600 {
					t.Fatalf("key mode is not owner-only: %v", err)
				}
			default:
				if !errors.Is(readErr, os.ErrNotExist) {
					t.Fatal("rejected setup left a bootstrap file")
				}
			}
			if test.failure == "" && test.name != "offline dry run" {
				var result map[string]string
				if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				setupAssertJSON(t, result, map[string]string{"command": "setup-auth", "profile": "hosted-cli"})
				if !installed || !reflect.DeepEqual(selected, []string{"platform/alpha", "platform/control", "platform/zeta"}) {
					t.Fatalf("installation differs from explicit targets: %v", selected)
				}
				if test.name == "create and add explicit targets" && !reflect.DeepEqual(additions, []string{"platform/alpha", "platform/zeta"}) {
					t.Fatalf("repository-admin additions bypassed or widened: %v", additions)
				}
				for _, want := range []string{"CAO_HOSTED_CLI_APP_ID=123", "CAO_HOSTED_CLI_PRIVATE_KEY_FILE=" + keyPath, "not serve-hosted", "secret manager", "separate from the dashboard login App"} {
					if !strings.Contains(stderr.String(), want) {
						t.Fatalf("missing executor handoff: %s", want)
					}
				}
			} else if strings.Contains(stderr.String(), "CAO_HOSTED_CLI_APP_ID=") {
				t.Fatal("failed or preview setup emitted success configuration")
			}
			if !bytes.Equal(beforePolicy, setupRead(t, f.policyPath())) || !bytes.Equal(beforeState, f.state(t)) ||
				!reflect.DeepEqual(tree, setupCheckoutState(t, f.checkout)) {
				t.Fatal("App setup changed rollout policy, Actions credentials, or checkout files")
			}
			f.api.mu.Lock()
			defer f.api.mu.Unlock()
			if len(f.api.Unhandled) != 0 {
				t.Fatalf("unsupported simulator API routes: %v", f.api.Unhandled)
			}
			for _, request := range f.api.Requests {
				switch request {
				case "GET /", "GET /user", "POST /graphql", "GET /users/platform", "GET /repos/platform/alpha", "GET /repos/platform/zeta":
				default:
					t.Errorf("unexpected API request or authority mutation: %s", request)
				}
			}
			if test.name == "offline dry run" || test.name == "cross-owner refused" || test.name == "existing key file refused" {
				if len(requests)+len(f.api.Requests) != 0 {
					t.Fatal("preview or invalid input contacted GitHub")
				}
			}
		})
	}
}

func setupHostedPermissions() map[string]string {
	return map[string]string{"actions": "write", "contents": "write", "metadata": "read", "pull_requests": "write", "workflows": "write"}
}

type setupHostedAppAPI struct {
	mu                   sync.Mutex
	t                    *testing.T
	base                 *BootstrapAPI
	key                  *rsa.PrivateKey
	pem, scenario        string
	manifest             map[string]any
	converted, installed bool
	selection            string
	selected, additions  []string
	requests             []string
}

func (a *setupHostedAppAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	path := r.URL.Path
	if path != "/app" && !strings.HasPrefix(path, "/app-manifests/") && !strings.HasPrefix(path, "/organizations/") &&
		!strings.HasPrefix(path, "/apps/") && !strings.HasPrefix(path, "/app/installations/") &&
		!strings.HasPrefix(path, "/orgs/") && !strings.HasPrefix(path, "/installation/") && !strings.HasPrefix(path, "/user/installations/") {
		a.base.ServeHTTP(w, r)
		return
	}
	a.requests = append(a.requests, r.Method+" "+path)
	w.Header().Set("Content-Type", "application/json")
	write := func(status int, body any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	switch {
	case r.Method == http.MethodPost && path == "/organizations/platform/settings/apps/new":
		if err := r.ParseForm(); err != nil || json.Unmarshal([]byte(r.Form.Get("manifest")), &a.manifest) != nil {
			a.t.Error("invalid manifest form")
			write(http.StatusBadRequest, nil)
			return
		}
		for key, want := range map[string]any{
			"name": "approved-hosted-app", "public": false, "request_oauth_on_install": false,
			"default_events": []string{}, "default_permissions": setupHostedPermissions(),
			"hook_attributes": map[string]any{"url": "https://github.com/platform/control", "active": false},
		} {
			setupAssertJSON(a.t, a.manifest[key], want)
		}
		callback, err := url.Parse(a.manifest["redirect_url"].(string))
		if err != nil || callback.Scheme != "http" || callback.Hostname() != "127.0.0.1" || callback.Path != "/callback" {
			a.t.Error("manifest callback escaped loopback")
			write(http.StatusBadRequest, nil)
			return
		}
		state := r.URL.Query().Get("state")
		if len(state) != 32 {
			a.t.Error("missing unpredictable manifest state")
		}
		if a.scenario == "invalid callback state" {
			state = "wrong-state"
		}
		http.Redirect(w, r, callback.String()+"?code=simulator-manifest-code&state="+state, http.StatusFound) // #nosec G710 -- test browser callback is validated above as numeric loopback HTTP /callback.
	case r.Method == http.MethodPost && path == "/app-manifests/simulator-manifest-code/conversions":
		if a.manifest == nil || r.Header.Get("Authorization") != "token simulator-token-with-no-external-authority" {
			a.t.Error("manifest exchange missing browser approval or operator authentication")
			write(http.StatusForbidden, nil)
			return
		}
		if a.scenario == "manifest conversion denied" {
			write(http.StatusForbidden, map[string]string{"message": "conversion denied"})
			return
		}
		a.converted = true
		write(http.StatusCreated, map[string]any{"id": 123, "client_id": "simulator-hosted-app", "pem": a.pem, "slug": "approved-hosted-app", "name": "approved-hosted-app"})
	case r.Method == http.MethodPost && (path == "/apps/approved-hosted-app/installations/new" || path == "/organizations/platform/settings/installations/456"):
		if !a.converted || r.ParseForm() != nil {
			write(http.StatusBadRequest, nil)
			return
		}
		a.installed, a.selection = true, r.Form.Get("repository_selection")
		a.selected = slices.Clone(r.Form["repository"])
		slices.Sort(a.selected)
		write(http.StatusOK, map[string]any{"id": 456})
	case r.Method == http.MethodGet && path == "/app":
		a.assertJWT(r)
		permissions := setupHostedPermissions()
		if a.scenario == "extra App permission" {
			permissions["administration"] = "read"
		}
		write(http.StatusOK, map[string]any{"id": 123, "client_id": "simulator-hosted-app", "slug": "approved-hosted-app", "public": false, "permissions": permissions})
	case r.Method == http.MethodGet && path == "/orgs/platform/installation":
		a.assertJWT(r)
		switch {
		case a.scenario == "installation API denied":
			write(http.StatusForbidden, map[string]string{"message": "installation denied"})
		case !a.installed:
			write(http.StatusNotFound, nil)
		default:
			write(http.StatusOK, map[string]any{"id": 456, "app_id": 123, "account": map[string]string{"login": "platform"}, "repository_selection": a.selection})
		}
	case r.Method == http.MethodPost && path == "/app/installations/456/access_tokens":
		a.assertJWT(r)
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			a.t.Error("invalid token body")
		}
		setupAssertJSON(a.t, body, map[string]any{"permissions": map[string]string{"metadata": "read"}})
		write(http.StatusCreated, map[string]string{"token": "simulator-installation-token"})
	case r.Method == http.MethodGet && path == "/installation/repositories":
		if r.Header.Get("Authorization") != "Bearer simulator-installation-token" {
			a.t.Error("repository verification did not use the installation token")
		}
		repositories := []map[string]string{}
		for _, name := range a.selected {
			repositories = append(repositories, map[string]string{"full_name": name})
		}
		write(http.StatusOK, map[string]any{"total_count": len(repositories), "repositories": repositories})
	case r.Method == http.MethodPut && strings.HasPrefix(path, "/user/installations/456/repositories/"):
		if !a.installed || a.selection != "selected" || r.Header.Get("Authorization") != "token simulator-token-with-no-external-authority" {
			a.t.Error("repository addition bypassed selected installation or operator authentication")
		}
		if a.scenario == "repository admin denied uses browser" {
			write(http.StatusForbidden, map[string]string{"message": "owner approval required"})
			return
		}
		id := strings.TrimPrefix(path, "/user/installations/456/repositories/")
		a.base.mu.Lock()
		var name string
		for _, repository := range a.base.Repositories {
			if id == strconv.FormatInt(repository.ID, 10) {
				name = repository.Owner + "/" + repository.Name
			}
		}
		a.base.mu.Unlock()
		if name != "platform/alpha" && name != "platform/zeta" {
			a.t.Errorf("unexpected repository addition: %s", name)
			write(http.StatusNotFound, nil)
			return
		}
		a.additions = append(a.additions, name)
		if a.scenario != "successful addition missing membership" {
			a.selected = append(a.selected, name)
			slices.Sort(a.selected)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		a.t.Errorf("unexpected hosted App API route: %s %s", r.Method, path)
		http.NotFound(w, r)
	}
}

func (a *setupHostedAppAPI) assertJWT(r *http.Request) {
	a.t.Helper()
	parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
	if len(parts) != 3 {
		a.t.Error("App request is not JWT-authenticated")
		return
	}
	claims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !bytes.Contains(claims, []byte(`"iss":"simulator-hosted-app"`)) {
		a.t.Error("App JWT has the wrong issuer")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err != nil || rsa.VerifyPKCS1v15(&a.key.PublicKey, crypto.SHA256, digest[:], signature) != nil {
		a.t.Error("App JWT signature is invalid")
	}
}

func setupHostedBrowserClient(t *testing.T, environment []string) *http.Client {
	t.Helper()
	values := map[string]string{}
	for _, item := range environment {
		key, value, _ := strings.Cut(item, "=")
		values[key] = value
	}
	proxy, err := url.Parse(values["HTTPS_PROXY"])
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(setupRead(t, values["SSL_CERT_FILE"])) {
		t.Fatal("invalid simulator root certificate")
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			Proxy: func(r *http.Request) (*url.URL, error) {
				if r.URL.Scheme == "http" && r.URL.Hostname() == "127.0.0.1" {
					return nil, nil
				}
				return proxy, nil
			},
			TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		},
	}
}

func setupHostedBrowserRequest(t *testing.T, ctx context.Context, client *http.Client, method, address string, form url.Values) (int, string, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, method, address, strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header.Get("Location"), body
}

func setupHostedApproveManifest(t *testing.T, ctx context.Context, client *http.Client, address, scenario string) {
	t.Helper()
	status, _, page := setupHostedBrowserRequest(t, ctx, client, http.MethodGet, address, nil)
	action := regexp.MustCompile(`action="([^"]+)"`).FindSubmatch(page)
	manifest := regexp.MustCompile(`name="manifest" value="([^"]+)"`).FindSubmatch(page)
	if status != http.StatusOK || len(action) != 2 || len(manifest) != 2 {
		t.Fatal("missing browser manifest form")
	}
	status, callback, _ := setupHostedBrowserRequest(t, ctx, client, http.MethodPost, html.UnescapeString(string(action[1])), url.Values{"manifest": {html.UnescapeString(string(manifest[1]))}})
	if status != http.StatusFound {
		t.Fatal("simulator did not approve manifest")
	}
	status, install, _ := setupHostedBrowserRequest(t, ctx, client, http.MethodGet, callback, nil)
	if scenario == "invalid callback state" || scenario == "manifest conversion denied" {
		if status != http.StatusBadRequest && status != http.StatusInternalServerError {
			t.Fatal("invalid callback or conversion was accepted")
		}
		return
	}
	if status != http.StatusFound || install != "https://github.com/apps/approved-hosted-app/installations/new" {
		t.Fatal("callback did not redirect to the expected App installation")
	}
	selection := "selected"
	if scenario == "all-repository installation" {
		selection = "all"
	}
	setupHostedApproveInstallation(t, ctx, client, install, selection, []string{"platform/control"})
}

func setupHostedApproveInstallation(t *testing.T, ctx context.Context, client *http.Client, address, selection string, repositories []string) {
	t.Helper()
	status, _, _ := setupHostedBrowserRequest(t, ctx, client, http.MethodPost, address, url.Values{"repository_selection": {selection}, "repository": repositories})
	if status != http.StatusOK {
		t.Fatalf("simulated installation approval failed: HTTP %d", status)
	}
}
