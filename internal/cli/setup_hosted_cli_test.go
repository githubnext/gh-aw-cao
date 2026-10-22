package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestHostedCLISetupOfflineContract(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("PATH", "")
	t.Setenv("GITHUB_API_URL", "")
	for _, host := range []string{"github.com", "contoso.ghe.com", "github.example.test"} {
		t.Run(host, func(t *testing.T) {
			t.Setenv("GH_HOST", host)
			gh := func(context.Context, ...string) (string, string, error) {
				t.Fatal("dry run must not call GitHub")
				return "", "", nil
			}
			root, stdout, stderr := testCommand(t, gh, nativeOperator(gh))
			root.SetArgs([]string{"setup", "auth", "hosted-cli", "--repo", "acme/control", "--target-repository", "ACME/one", "--target-repository", "acme/control", "--dry-run"})
			if err := root.ExecuteContext(t.Context()); err != nil {
				t.Fatal(err)
			}
			var result struct {
				Repo                string
				InstallationTargets []nativeSetupOwnerGroup
				Manifest            map[string]any
				Environment         map[string]string
			}
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			wantTargets := []nativeSetupOwnerGroup{{Owner: "acme", Repositories: []string{"control", "one"}}}
			if result.Repo != "acme/control" || !reflect.DeepEqual(result.InstallationTargets, wantTargets) || stderr.Len() != 0 {
				t.Fatalf("incorrect scope/output: %s %s", stdout, stderr)
			}
			m := result.Manifest
			if m["name"] != "cao-acme-control-cli" || m["public"] != false || m["request_oauth_on_install"] != false ||
				m["redirect_url"] != "http://127.0.0.1:0/callback" || m["url"] != "https://"+host+"/acme/control" ||
				nativeSetupMap(m["hook_attributes"])["active"] != false || len(m["default_events"].([]any)) != 0 {
				t.Fatalf("unsafe manifest: %#v", m)
			}
			permissions, _ := json.Marshal(m["default_permissions"])
			if string(permissions) != `{"actions":"write","contents":"write","metadata":"read","pull_requests":"write","workflows":"write"}` {
				t.Fatalf("permissions widened or changed: %s", permissions)
			}
			if !reflect.DeepEqual(result.Environment, map[string]string{
				"appId": "CAO_HOSTED_CLI_APP_ID", "privateKeyFile": "CAO_HOSTED_CLI_PRIVATE_KEY_FILE",
				"controlRepository": "CAO_HOSTED_CLI_CONTROL_REPOSITORY", "apiUrl": "CAO_HOSTED_CLI_GITHUB_API_URL",
			}) {
				t.Fatalf("credentials not separated: %#v", result.Environment)
			}
		})
	}
	root, stdout, _ := testCommand(t, nil, nil)
	root.SetArgs([]string{"setup", "auth", "hosted-cli", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"temporary bootstrap file", "0600", "never overwritten", "--no-open", "--target-repository", "--app-name", "--dry-run", "Only select repositories"} {
		if !strings.Contains(strings.ToLower(stdout.String()), strings.ToLower(want)) {
			t.Fatalf("help omits %s", want)
		}
	}
	files, err := os.ReadDir(".")
	if err != nil || len(files) != 0 {
		t.Fatalf("offline setup wrote files: %v %v", files, err)
	}
}

func TestHostedCLISetupRejectsBeforeSideEffects(t *testing.T) {
	t.Setenv("GH_HOST", "github.com")
	t.Setenv("GITHUB_API_URL", "")
	directory := t.TempDir()
	existing := filepath.Join(directory, "existing.pem")
	writeTestFile(t, existing, "keep")
	for _, flags := range [][]string{
		{}, {"--repo", "acme"}, {"--repo", "acme/control"},
		{"--repo", "-bad/control", "--dry-run"},
		{"--repo", "acme/control", "--target-repository", "other/one", "--dry-run"},
		{"--repo", "acme/control", "--target-repository", "acme/*", "--dry-run"},
		{"--repo", "acme/control", "--app-name", "GitHub-app", "--dry-run"},
		{"--repo", "acme/control", "--app-name", "bad name", "--dry-run"},
		{"--repo", "acme/control", "--app-name", "", "--dry-run"},
		{"--repo", "acme/control", "--private-key-out", existing},
		{"--repo", "acme/control", "--private-key-out", filepath.Join(directory, "missing", "key.pem")},
		{"--repo", "acme/control", "--policy", "policy.json", "--dry-run"},
		{"--repo", "acme/control", "--force", "--dry-run"},
	} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			gh := func(context.Context, ...string) (string, string, error) {
				t.Fatal("invalid input must fail before GitHub calls")
				return "", "", nil
			}
			root, stdout, _ := testCommand(t, gh, nativeOperator(gh))
			root.SetArgs(append([]string{"setup", "auth", "hosted-cli"}, flags...))
			if err := root.ExecuteContext(t.Context()); err == nil || stdout.Len() != 0 {
				t.Fatalf("invalid input accepted: %v %s", err, stdout)
			}
		})
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(directory, "link.pem")
		if err := os.Symlink(existing, link); err != nil {
			t.Fatal(err)
		}
		root, _, _ := testCommand(t, nil, nativeOperator(nil))
		root.SetArgs([]string{"setup", "auth", "hosted-cli", "--repo", "acme/control", "--private-key-out", link})
		if err := root.Execute(); err == nil {
			t.Fatal("linked destination accepted")
		}
	}
	data, err := os.ReadFile(existing)
	if err != nil || string(data) != "keep" {
		t.Fatal("existing bootstrap file was overwritten")
	}
}

func hostedCLICompleteRegistration(t *testing.T, address, key string, invalid bool) {
	t.Helper()
	response, err := http.Get(address)
	if err != nil {
		t.Fatal(err)
	}
	page, err := io.ReadAll(response.Body)
	if closeErr := response.Body.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if err != nil {
		t.Fatal(err)
	}
	action := regexp.MustCompile(`action="([^"]+)"`).FindStringSubmatch(string(page))
	manifest := regexp.MustCompile(`name="manifest" value="([^"]+)"`).FindStringSubmatch(string(page))
	if len(action) != 2 || len(manifest) != 2 || bytes.Contains(page, []byte(key)) {
		t.Fatal("invalid registration page")
	}
	registration, err := url.Parse(html.UnescapeString(action[1]))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(html.UnescapeString(manifest[1])), &body); err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(nativeSetupHostedProfile().Permissions)
	actual, _ := json.Marshal(body["default_permissions"])
	if !bytes.Equal(actual, want) || body["name"] != "chosen-hosted-app" ||
		body["description"] != nativeSetupAppDescription("acme/control", nativeSetupHostedProfile()) {
		t.Fatalf("browser received wrong manifest: %#v", body)
	}
	state := registration.Query().Get("state")
	if len(state) != 32 {
		t.Fatal("callback state is not unpredictable")
	}
	if invalid {
		state = "wrong"
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	callback, err := client.Get(body["redirect_url"].(string) + "?code=manifest-code&state=" + state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := callback.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	wantStatus := http.StatusFound
	if invalid {
		wantStatus = http.StatusBadRequest
	}
	if callback.StatusCode != wantStatus {
		t.Fatalf("callback status=%d want=%d", callback.StatusCode, wantStatus)
	}
}

func TestHostedCLISetupNativeApply(t *testing.T) {
	for _, scenario := range []string{"add", "already selected", "denied addition", "invalid repository ID", "unverified addition", "all repositories", "extra read permission", "missing permission", "API failure", "invalid callback", "auth failure", "wrong repository"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("GH_HOST", "github.com")
			directory := t.TempDir()
			keyPath := filepath.Join(directory, "bootstrap.pem")
			key := nativeSetupTestKey(t)
			selected := scenario == "already selected"
			browserFallback, added, converted := false, false, false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer ") {
					t.Error("App request lacks bearer authentication")
				}
				switch req.URL.Path {
				case "/app":
					if scenario == "API failure" {
						w.WriteHeader(http.StatusForbidden)
						_, _ = io.WriteString(w, key)
						return
					}
					permissions := nativeSetupHostedProfile().Permissions
					if scenario == "extra read permission" {
						permissions["administration"] = "read"
					}
					if scenario == "missing permission" {
						delete(permissions, "workflows")
					}
					nativeSetupTestJSON(t, w, map[string]any{"id": 123, "client_id": "Iv1.hosted", "slug": "hosted-app", "public": false, "permissions": permissions})
				case "/orgs/acme/installation":
					selection := "selected"
					if scenario == "all repositories" {
						selection = "all"
					}
					nativeSetupTestJSON(t, w, map[string]any{"id": 456, "app_id": 123, "account": map[string]string{"login": "ACME"}, "repository_selection": selection})
				case "/app/installations/456/access_tokens":
					var body map[string]any
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if !reflect.DeepEqual(body, map[string]any{"permissions": map[string]any{"metadata": "read"}}) {
						t.Error("verification must use metadata-only tokens")
					}
					nativeSetupTestJSON(t, w, map[string]string{"token": "ephemeral-test-token"})
				case "/installation/repositories":
					repositories := []map[string]string{{"full_name": "acme/control"}}
					if selected {
						repositories = append(repositories, map[string]string{"full_name": "acme/target"})
					}
					nativeSetupTestJSON(t, w, map[string]any{"total_count": len(repositories), "repositories": repositories})
				default:
					t.Errorf("unexpected API request: %s", req.URL.Path)
					http.NotFound(w, req)
				}
			}))
			defer server.Close()
			t.Setenv("GITHUB_API_URL", server.URL)
			gh := func(_ context.Context, args ...string) (string, string, error) {
				call := strings.Join(args, " ")
				if strings.Contains(call, key) || strings.Contains(call, "ephemeral-test-token") {
					t.Fatal("credentials passed in command arguments")
				}
				switch {
				case call == "auth status":
					if scenario == "auth failure" {
						return "", "not logged in", errors.New("denied")
					}
					return "", "", nil
				case call == "repo view acme/control --json nameWithOwner --jq .nameWithOwner":
					if scenario == "wrong repository" {
						return "other/control", "", nil
					}
					return "acme/control", "", nil
				case call == "api /users/acme --jq .login":
					return "acme", "", nil
				case args[0] == "browse" && strings.Contains(args[1], "/register"):
					hostedCLICompleteRegistration(t, args[1], key, scenario == "invalid callback")
					return "", "", nil
				case call == "api -X POST -H Accept: application/vnd.github+json /app-manifests/manifest-code/conversions":
					converted = true
					data, _ := json.Marshal(map[string]any{"id": 123, "client_id": "Iv1.hosted", "pem": key, "slug": "hosted-app", "name": "chosen-hosted-app"})
					return string(data), "", nil
				case call == "api /repos/acme/target --jq .id":
					if scenario == "invalid repository ID" {
						return "../bad", "", nil
					}
					return "789", "", nil
				case call == "api -X PUT /user/installations/456/repositories/789 --silent":
					if scenario == "denied addition" {
						return key, key, errors.New(key)
					}
					added = true
					if scenario != "unverified addition" {
						selected = true
					}
					return "", "", nil
				case call == "browse https://github.com/organizations/acme/settings/installations/456":
					browserFallback, selected = true, true
					return "", "", nil
				default:
					t.Fatalf("unexpected gh command or authority mutation: %s", call)
					return "", "", nil
				}
			}
			root, stdout, stderr := testCommand(t, gh, nativeOperator(gh))
			root.SetArgs([]string{"setup", "auth", "hosted-cli", "--repo", "acme/control", "--target-repository", "acme/target", "--app-name", "chosen-hosted-app", "--private-key-out", keyPath})
			err := root.ExecuteContext(t.Context())
			success := scenario == "add" || scenario == "already selected" || scenario == "denied addition" || scenario == "invalid repository ID"
			if (err == nil) != success {
				t.Fatalf("unexpected result: %v\n%s", err, stderr)
			}
			if strings.Contains(stdout.String()+stderr.String()+fmt.Sprint(err), key) || strings.Contains(stderr.String(), "ephemeral-test-token") {
				t.Fatal("secret leaked into output or errors")
			}
			data, readErr := os.ReadFile(keyPath)
			if !converted {
				if !errors.Is(readErr, os.ErrNotExist) {
					t.Fatalf("failed pre-creation setup left a bootstrap file: %v", readErr)
				}
			} else {
				if readErr != nil || string(data) != key {
					t.Fatalf("downloaded private key was not retained: %v", readErr)
				}
				info, err := os.Stat(keyPath)
				if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
					t.Fatalf("unsafe key permissions: %v", err)
				}
			}
			wantFallback := scenario == "denied addition" || scenario == "invalid repository ID"
			if browserFallback != wantFallback || (scenario == "already selected" && added) {
				t.Fatal("installation approval/addition flow changed")
			}
			if success {
				var result map[string]string
				if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || !reflect.DeepEqual(result, map[string]string{"command": "setup-auth", "profile": "hosted-cli"}) {
					t.Fatalf("setup result contract changed: %s (%v)", stdout, err)
				}
				for _, want := range []string{"CAO_HOSTED_CLI_APP_ID=123", "CAO_HOSTED_CLI_PRIVATE_KEY_FILE=" + keyPath, "CAO_HOSTED_CLI_CONTROL_REPOSITORY=acme/control", "CAO_HOSTED_CLI_GITHUB_API_URL=" + server.URL, "not serve-hosted", "secret manager", "separate from the dashboard login App"} {
					if !strings.Contains(stderr.String(), want) {
						t.Fatalf("missing secure handoff %q: %s", want, stderr)
					}
				}
			} else if strings.Contains(stderr.String(), "CAO_HOSTED_CLI_APP_ID=") {
				t.Fatal("unverified setup emitted success instructions")
			}
		})
	}
}

func TestHostedCLINoOpenAndCancellation(t *testing.T) {
	cmd := nativeSetupTestCommand()
	gh := func(context.Context, ...string) (string, string, error) {
		t.Fatal("--no-open must not spawn a browser")
		return "", "", nil
	}
	if err := nativeSetupOpen(cmd, gh, "https://github.com/apps/hosted-app/installations/new", true); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cmd.ErrOrStderr().(*bytes.Buffer).String(), "https://github.com/apps/hosted-app/installations/new") {
		t.Fatal("--no-open did not print browser URL")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	cmd.SetContext(ctx)
	if _, err := nativeSetupCreateApp(cmd, gh, "acme", "hosted-app", "https://github.com/acme/control", nativeSetupHostedProfile(), true); !errors.Is(err, context.Canceled) {
		t.Fatalf("browser setup ignored cancellation: %v", err)
	}
}
