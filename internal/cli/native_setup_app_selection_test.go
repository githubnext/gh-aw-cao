package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/spf13/cobra"
)

func TestNativeSetupAppInstallSelection(t *testing.T) {
	for _, test := range []struct {
		server string
		count  int
	}{
		{"https://github.com", 0},
		{"https://github.com", 1},
		{"https://github.com", 2},
		{"https://github.com", 100},
		{"https://github.com", 101},
		{"https://github.example.test", 101},
		{"https://contoso.ghe.com", 101},
		{"https://github.com.example.test", 1},
		{"https://github.com:8443", 1},
	} {
		t.Run(fmt.Sprintf("%s/%d", test.server, test.count), func(t *testing.T) {
			cmd := nativeSetupTestCommand()
			target := nativeSetupOwnerGroup{Owner: "org"}
			wantIDs := []string{}
			for i := 0; i < test.count; i++ {
				target.Repositories = append(target.Repositories, fmt.Sprintf("repo-%d", i))
				wantIDs = append(wantIDs, strconv.FormatInt(9007199254740993+int64(i), 10))
			}
			lookups := 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				want := []string{"api", "/repos/org/" + target.Repositories[lookups]}
				if !reflect.DeepEqual(args, want) {
					t.Fatalf("unexpected metadata lookup: %v", args)
				}
				response := fmt.Sprintf(`{"id":%s,"full_name":"ORG/%s","owner":{"id":42,"login":"ORG"}}`, wantIDs[lookups], target.Repositories[lookups])
				lookups++
				return response, "", nil
			}
			selection, err := nativeSetupAppInstallSelection(cmd, gh, test.server, target)
			supported := test.server == "https://github.com"
			if supported && (test.count == 0 || test.count > 100) {
				if err == nil || selection != nil || lookups != 0 {
					t.Fatalf("unsafe selection was not rejected before lookup: %v %v %d", selection, err, lookups)
				}
				if test.count > 100 && !strings.Contains(err.Error(), "--read-client-id and --write-client-id") {
					t.Fatalf("oversized selection has no manual recovery: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			address := nativeSetupAppInstallURL(test.server, target.Owner, "test-app", selection)
			parsed, err := url.Parse(address)
			if err != nil {
				t.Fatal(err)
			}
			if supported {
				want := url.Values{"suggested_target_id": {"42"}, "repository_ids[]": wantIDs}
				if lookups != test.count || parsed.Path != "/apps/test-app/installations/new/permissions" ||
					!reflect.DeepEqual(parsed.Query(), want) || strings.Count(parsed.RawQuery, "repository_ids%5B%5D=") != test.count {
					t.Fatalf("not an exact repeated numeric-ID selection: %s (lookups=%d)", address, lookups)
				}
			} else {
				path := "/apps/test-app/installations/new"
				if strings.HasSuffix(test.server, ".ghe.com") {
					path = "/organizations/org/settings/apps/test-app/installations"
				}
				if selection != nil || lookups != 0 || address != test.server+path {
					t.Fatalf("unsupported host changed URL or performed lookups: %s (%d)", address, lookups)
				}
			}
		})
	}
}

func TestNativeSetupAppPreselectionFailsBeforeRegistration(t *testing.T) {
	valid := `{"id":101,"full_name":"org/control","owner":{"id":42,"login":"ORG"}}`
	for _, test := range []struct {
		name, response string
		lookupFailure  bool
	}{
		{"lookup failure", "sensitive response", true},
		{"invalid JSON", "{sensitive response", false},
		{"missing metadata", `{}`, false},
		{"missing repository ID", strings.Replace(valid, `"id":101,`, "", 1), false},
		{"null repository ID", strings.Replace(valid, `"id":101`, `"id":null`, 1), false},
		{"zero repository ID", strings.Replace(valid, `"id":101`, `"id":0`, 1), false},
		{"negative repository ID", strings.Replace(valid, `"id":101`, `"id":-1`, 1), false},
		{"fractional repository ID", strings.Replace(valid, `"id":101`, `"id":1.5`, 1), false},
		{"exponent repository ID", strings.Replace(valid, `"id":101`, `"id":1e2`, 1), false},
		{"string repository ID", strings.Replace(valid, `"id":101`, `"id":"101"`, 1), false},
		{"GraphQL repository ID", strings.Replace(valid, `"id":101`, `"id":"R_kgDOExample"`, 1), false},
		{"overflowing repository ID", strings.Replace(valid, `"id":101`, `"id":9223372036854775808`, 1), false},
		{"missing owner ID", strings.Replace(valid, `"id":42,`, "", 1), false},
		{"null owner ID", strings.Replace(valid, `"id":42`, `"id":null`, 1), false},
		{"zero owner ID", strings.Replace(valid, `"id":42`, `"id":0`, 1), false},
		{"negative owner ID", strings.Replace(valid, `"id":42`, `"id":-1`, 1), false},
		{"fractional owner ID", strings.Replace(valid, `"id":42`, `"id":4.2`, 1), false},
		{"GraphQL owner ID", strings.Replace(valid, `"id":42`, `"id":"O_kgDOExample"`, 1), false},
		{"missing owner login", strings.Replace(valid, `"login":"ORG"`, `"login":null`, 1), false},
		{"wrong owner", strings.Replace(valid, `"login":"ORG"`, `"login":"other"`, 1), false},
		{"renamed repository", strings.Replace(valid, `"org/control"`, `"org/renamed"`, 1), false},
		{"missing full name", strings.Replace(valid, `"org/control"`, `null`, 1), false},
		{"inconsistent owner ID", strings.Replace(valid, `"id":42`, `"id":43`, 1), false},
		{"duplicate repository ID", strings.Replace(valid, `"id":101`, `"id":102`, 1), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("GH_HOST", "github.com")
			cmd := nativeSetupTestCommand()
			lookups := 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				switch strings.Join(args, " ") {
				case "api /repos/org/evidence":
					lookups++
					return `{"id":102,"full_name":"org/evidence","owner":{"id":42,"login":"org"}}`, "", nil
				case "api /repos/org/control":
					lookups++
					if test.lookupFailure {
						return test.response, "sensitive stderr", errors.New("sensitive error")
					}
					return test.response, "", nil
				default:
					t.Fatalf("failed preselection must not register, browse, or write credentials: %v", args)
					return "", "", nil
				}
			}
			target := nativeSetupOwnerGroup{Owner: "org", Repositories: []string{"evidence", "control"}}
			_, err := nativeSetupCreateApp(cmd, gh, target, "test-app", "https://github.com/org/control", nativeSetupCredentials(false)[0], false)
			if err == nil || !strings.Contains(err.Error(), "org/control") || !strings.Contains(err.Error(), "retry") || lookups != 2 {
				t.Fatalf("incomplete selection did not fail actionably: %v (lookups=%d)", err, lookups)
			}
			output := cmd.ErrOrStderr().(*bytes.Buffer).String() + cmd.OutOrStdout().(*bytes.Buffer).String()
			if output != "" || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("failed preselection emitted a URL or sensitive details: %q %v", output, err)
			}
		})
	}
}

func TestNativeSetupAppInstallationOpener(t *testing.T) {
	key := nativeSetupTestKey(t)
	for _, test := range []struct {
		name, host                   string
		existing, covered, firstOpen bool
		noOpen, invalidIDs, all      bool
		count                        int
	}{
		{name: "new", host: "github.com"},
		{name: "new no-open", host: "github.com", noOpen: true},
		{name: "invalid IDs", host: "github.com", invalidIDs: true},
		{name: "oversized new", host: "github.com", count: 101},
		{name: "existing Configure", host: "github.com", existing: true},
		{name: "existing Configure no-open", host: "github.com", existing: true, noOpen: true},
		{name: "oversized existing Configure", host: "github.com", existing: true, count: 101},
		{name: "already covered", host: "github.com", existing: true, covered: true},
		{name: "already open after creation", host: "github.com", firstOpen: true},
		{name: "all repositories rejected", host: "github.com", existing: true, all: true},
		{name: "GHES new", host: "github.example.test", count: 101},
		{name: "GHES existing", host: "github.example.test", existing: true},
		{name: "data residency new", host: "contoso.ghe.com", count: 101},
		{name: "data residency existing", host: "contoso.ghe.com", existing: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("GH_HOST", test.host)
			target := nativeSetupOwnerGroup{Owner: "org", Repositories: []string{"control", "evidence"}}
			if test.count != 0 {
				target.Repositories = nil
				for i := 0; i < test.count; i++ {
					target.Repositories = append(target.Repositories, fmt.Sprintf("repo-%d", i))
				}
			}
			var installationCalls atomic.Int32
			readyAt := int32(3)
			if test.firstOpen {
				readyAt = 2
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				switch req.URL.Path {
				case "/orgs/org/installation":
					ready := installationCalls.Add(1) >= readyAt
					if !test.existing && !ready {
						http.NotFound(w, req)
						return
					}
					selection := "selected"
					if test.all {
						selection = "all"
					}
					nativeSetupTestJSON(t, w, map[string]any{"id": 456, "app_id": 123, "account": map[string]string{"login": "org"}, "repository_selection": selection})
				case "/app/installations/456/access_tokens":
					nativeSetupTestJSON(t, w, map[string]string{"token": "test-metadata-token"})
				case "/installation/repositories":
					repositories := []map[string]string{}
					if test.covered || installationCalls.Load() >= readyAt {
						for _, name := range target.Repositories {
							repositories = append(repositories, map[string]string{"full_name": "org/" + name})
						}
					}
					nativeSetupTestJSON(t, w, map[string]any{"total_count": len(repositories), "repositories": repositories})
				default:
					t.Errorf("unexpected App request: %s", req.URL.Path)
					http.NotFound(w, req)
				}
			}))
			defer server.Close()
			addresses := []string{}
			lookups := 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				if len(args) == 2 && args[0] == "browse" {
					addresses = append(addresses, args[1])
					return "", "", nil
				}
				if len(args) == 2 && args[0] == "api" && strings.HasPrefix(args[1], "/repos/org/") {
					lookups++
					if test.invalidIDs {
						return `{}`, "", nil
					}
					return fmt.Sprintf(`{"id":%d,"full_name":%q,"owner":{"id":42,"login":"org"}}`, 100+lookups, strings.TrimPrefix(args[1], "/repos/")), "", nil
				}
				t.Fatalf("unexpected gh call: %v", args)
				return "", "", nil
			}
			cmd := nativeSetupTestCommand()
			api := nativeSetupAppAPI{base: server.URL, client: server.Client()}
			app := nativeSetupApp{ID: "123", ClientID: "Iv1.test", PEM: key, Slug: "test-app", Name: "Test App"}
			err := nativeSetupEnsureInstallations(cmd, gh, api, app, []nativeSetupOwnerGroup{target}, test.noOpen, test.firstOpen)
			failure := test.invalidIDs || test.all || (test.count > 100 && !test.existing && test.host == "github.com")
			if (err != nil) != failure {
				t.Fatalf("unexpected installation result: %v", err)
			}
			output := cmd.ErrOrStderr().(*bytes.Buffer).String()
			if failure {
				if len(addresses) != 0 || strings.Contains(output, "Open this URL") {
					t.Fatal("failed selection opened or printed an installation URL")
				}
				wantLookups := 0
				if test.invalidIDs {
					wantLookups = 1
				}
				if lookups != wantLookups {
					t.Fatalf("failed installation performed unnecessary lookups: %d, want %d", lookups, wantLookups)
				}
				if test.all && !errors.Is(err, errNativeSetupInstallationScope) {
					t.Fatalf("all-repositories verification changed: %v", err)
				}
				return
			}
			preselected := test.host == "github.com" && !test.existing && !test.covered && !test.firstOpen
			wantLookups := 0
			if preselected {
				wantLookups = len(target.Repositories)
			}
			if lookups != wantLookups {
				t.Fatalf("unnecessary or incomplete metadata lookups: %d, want %d", lookups, wantLookups)
			}
			if test.covered || test.firstOpen {
				if len(addresses) != 0 || strings.Contains(output, "Open this URL") {
					t.Fatal("covered or first-open installation was reopened")
				}
				return
			}
			wantAddress := "https://" + test.host + "/apps/test-app/installations/new"
			if test.existing {
				wantAddress = "https://" + test.host + "/organizations/org/settings/installations/456"
			} else if strings.HasSuffix(test.host, ".ghe.com") {
				wantAddress = "https://" + test.host + "/organizations/org/settings/apps/test-app/installations"
			} else if preselected {
				wantAddress += "/permissions?repository_ids%5B%5D=101&repository_ids%5B%5D=102&suggested_target_id=42"
			}
			if test.noOpen {
				if len(addresses) != 0 || !strings.Contains(output, "Open this URL to continue: "+wantAddress+"\n") {
					t.Fatalf("--no-open lost the exact URL: %v %s", addresses, output)
				}
			} else if !reflect.DeepEqual(addresses, []string{wantAddress}) {
				t.Fatalf("wrong installation opener: %v, want %s", addresses, wantAddress)
			}
			if strings.Contains(output, "Review the preselected repositories") != preselected || !strings.Contains(output, "Only select repositories") {
				t.Fatalf("installation instructions do not match the flow: %s", output)
			}
		})
	}
}

func TestNativeSetupAppPreselectionDryRunLimit(t *testing.T) {
	t.Setenv("GH_HOST", "github.com")
	for _, count := range []int{100, 101} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			policy := nativeSetupTestPolicy()
			repositories := []string{}
			for i := 1; i < count; i++ {
				repositories = append(repositories, fmt.Sprintf("org/repo-%d", i))
			}
			nativeSetupMap(nativeSetupMap(policy["control-plane"])["scope"])["allowed-repositories"] = repositories
			gh := func(context.Context, ...string) (string, string, error) {
				t.Fatal("dry-run must not resolve metadata, browse, or write credentials")
				return "", "", nil
			}
			cmd := nativeSetupTestCommand()
			result, err := nativeSetupAuthenticate(cmd, gh, "github-app", nativeSetupAuthOptions{repo: "org/control", dryRun: true}, policy)
			if err != nil {
				t.Fatal(err)
			}
			targets := result["installationTargets"].(map[string][]nativeSetupOwnerGroup)
			if len(targets["read"]) != 1 || len(targets["read"][0].Repositories) != count ||
				!reflect.DeepEqual(targets["write"], []nativeSetupOwnerGroup{{Owner: "org", Repositories: []string{"control"}}}) {
				t.Fatalf("dry-run truncated or widened scope: %#v", targets)
			}
			if cmd.ErrOrStderr().(*bytes.Buffer).Len() != 0 {
				t.Fatal("offline preview emitted a browser handoff")
			}
		})
	}
}

func TestNativeSetupAppPreselectionNoOpen(t *testing.T) {
	t.Setenv("GH_HOST", "github.com")
	cmd := nativeSetupTestCommand()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	cmd.SetContext(ctx)
	gh := func(_ context.Context, args ...string) (string, string, error) {
		if !reflect.DeepEqual(args, []string{"api", "/repos/org/control"}) {
			t.Fatalf("--no-open must not browse or register automatically: %v", args)
		}
		cancel()
		return `{"id":101,"full_name":"org/control","owner":{"id":42,"login":"org"}}`, "", nil
	}
	target := nativeSetupOwnerGroup{Owner: "org", Repositories: []string{"control"}}
	_, err := nativeSetupCreateApp(cmd, gh, target, "test-app", "https://github.com/org/control", nativeSetupCredentials(false)[0], true)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("creation ignored cancellation: %v", err)
	}
	output := cmd.ErrOrStderr().(*bytes.Buffer).String()
	if !regexp.MustCompile(`Open this URL to continue: http://127\.0\.0\.1:\d+/register`).MatchString(output) ||
		!strings.Contains(output, "review the preselected repositories on org: control") {
		t.Fatalf("--no-open did not print the local registration handoff: %s", output)
	}
}

func TestNativeSetupAppPreselectionScopes(t *testing.T) {
	key := nativeSetupTestKey(t)
	for _, explicitWrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("explicit-write=%t", explicitWrite), func(t *testing.T) {
			t.Setenv("GH_HOST", "github.com")
			wantRepos := map[string][]string{"read": {"control", "evidence"}, "write": {"control"}}
			repositoryIDs := map[string]string{"control": "101", "evidence": "102", "reviews": "103"}
			options := nativeSetupAuthOptions{repo: "org/control"}
			if explicitWrite {
				options.write = []string{"org/reviews"}
				wantRepos["write"] = []string{"reviews"}
			}
			profiles := map[string]nativeSetupCredential{}
			for _, profile := range nativeSetupCredentials(false) {
				profiles[profile.Role] = profile
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				token := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
				role := strings.TrimPrefix(token, "test-metadata-")
				if strings.Count(token, ".") == 2 {
					claims, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
					var payload struct{ Iss string }
					if err != nil || json.Unmarshal(claims, &payload) != nil {
						t.Error("invalid App verification JWT")
						http.Error(w, "invalid JWT", http.StatusUnauthorized)
						return
					}
					role = strings.TrimPrefix(payload.Iss, "Iv1.")
				}
				appID, installationID := 123, 456
				if role == "write" {
					appID, installationID = 124, 457
				} else if role != "read" {
					t.Errorf("unexpected credential role: %s", role)
					http.Error(w, "invalid role", http.StatusUnauthorized)
					return
				}
				switch req.URL.Path {
				case "/orgs/org/installation":
					nativeSetupTestJSON(t, w, map[string]any{"id": installationID, "app_id": appID, "account": map[string]string{"login": "org"}, "repository_selection": "selected"})
				case fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
					nativeSetupTestJSON(t, w, map[string]string{"token": "test-metadata-" + role})
				case "/installation/repositories":
					repositories := []map[string]string{}
					for _, name := range wantRepos[role] {
						repositories = append(repositories, map[string]string{"full_name": "org/" + name})
					}
					nativeSetupTestJSON(t, w, map[string]any{"total_count": len(repositories), "repositories": repositories})
				default:
					t.Errorf("unexpected App request: %s", req.URL.Path)
					http.NotFound(w, req)
				}
			}))
			defer server.Close()
			t.Setenv("GITHUB_API_URL", server.URL)
			variables, secrets := []string{}, []string{}
			cmd := nativeSetupTestCommand()
			cmd.SetContext(context.WithValue(t.Context(), nativeSetupExecKey{}, nativeSetupExecFunc(func(_ *cobra.Command, name string, input io.Reader, args ...string) (string, error) {
				if name != "gh" || len(args) != 5 || args[0] != "secret" || args[1] != "set" || args[3] != "--repo" || args[4] != "org/control" {
					t.Fatalf("unexpected secret mutation: %s %v", name, args)
				}
				data, err := io.ReadAll(input)
				if err != nil || string(data) != key {
					t.Fatal("private key was not passed through protected stdin")
				}
				secrets = append(secrets, args[2])
				return "", nil
			})))
			browsed, lookups := 0, 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				call := strings.Join(args, " ")
				switch {
				case call == "auth status":
					return "", "", nil
				case call == "repo view org/control --json nameWithOwner --jq .nameWithOwner":
					return "org/control", "", nil
				case call == "api /users/org --jq .login":
					return "org", "", nil
				case strings.HasPrefix(call, "api /repos/org/control/actions/variables?"):
					return strings.Join(variables, "\n"), "", nil
				case strings.HasPrefix(call, "api /repos/org/control/actions/secrets?"):
					return strings.Join(secrets, "\n"), "", nil
				case len(args) == 2 && args[0] == "api" && strings.HasPrefix(args[1], "/repos/org/"):
					repo := strings.TrimPrefix(args[1], "/repos/org/")
					id, ok := repositoryIDs[repo]
					if !ok {
						t.Fatalf("lookup outside exact scope: %s", repo)
					}
					lookups++
					return fmt.Sprintf(`{"id":%s,"full_name":"org/%s","owner":{"id":42,"login":"org"}}`, id, repo), "", nil
				case args[0] == "variable":
					variables = append(variables, args[2])
					return "", "", nil
				case strings.HasPrefix(call, "api -X POST -H Accept: application/vnd.github+json /app-manifests/manifest-"):
					role := strings.TrimSuffix(strings.TrimPrefix(args[len(args)-1], "/app-manifests/manifest-"), "/conversions")
					id := 123
					if role == "write" {
						id = 124
					}
					data, _ := json.Marshal(map[string]any{"id": id, "client_id": "Iv1." + role, "pem": key, "slug": role + "-app", "name": role + " App"})
					return string(data), "", nil
				case args[0] == "browse" && strings.HasPrefix(args[1], "http://127.0.0.1:") && strings.HasSuffix(args[1], "/register"):
					browsed++
					response, err := http.Get(args[1])
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
					if len(action) != 2 || len(manifest) != 2 {
						t.Fatal("missing manifest form")
					}
					registration, err := url.Parse(html.UnescapeString(action[1]))
					if err != nil {
						t.Fatal(err)
					}
					var body struct {
						Name        string
						RedirectURL string            `json:"redirect_url"`
						Permissions map[string]string `json:"default_permissions"`
					}
					if err := json.Unmarshal([]byte(html.UnescapeString(manifest[1])), &body); err != nil {
						t.Fatal(err)
					}
					role := strings.TrimPrefix(body.Name, "cao-org-control-")
					if !reflect.DeepEqual(body.Permissions, profiles[role].Permissions) {
						t.Fatalf("permissions changed for %s", role)
					}
					client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
					callback, err := client.Get(body.RedirectURL + "?code=manifest-" + role + "&state=" + registration.Query().Get("state"))
					if err != nil {
						t.Fatal(err)
					}
					defer func() {
						if err := callback.Body.Close(); err != nil {
							t.Error(err)
						}
					}()
					location, err := callback.Location()
					if err != nil || callback.StatusCode != http.StatusFound {
						t.Fatalf("invalid manifest callback: %v", err)
					}
					want := url.Values{"suggested_target_id": {"42"}}
					for _, repo := range wantRepos[role] {
						want.Add("repository_ids[]", repositoryIDs[repo])
					}
					if location.Host != "github.com" || location.Path != "/apps/"+role+"-app/installations/new/permissions" ||
						!reflect.DeepEqual(location.Query(), want) {
						t.Fatalf("%s scope changed in initial creation redirect: %s, want %v", role, location, want)
					}
					return "", "", nil
				default:
					t.Errorf("unexpected gh operation: %v", args)
					return "", "", errors.New("unexpected gh operation")
				}
			}
			policy := nativeSetupTestPolicy()
			scope := nativeSetupMap(nativeSetupMap(policy["control-plane"])["scope"])
			scope["allowed-owners"] = []string{"org", "unrelated"}
			scope["allowed-repositories"] = []string{"org/evidence", "ORG/evidence"}
			result, err := nativeSetupAuthenticate(cmd, gh, "github-app", options, policy)
			if err != nil || result["profile"] != "github-app" {
				t.Fatalf("setup failed: %v %#v", err, result)
			}
			if browsed != 2 || lookups != 3 || len(secrets) != 2 || len(variables) != 3 {
				t.Fatalf("incorrect creation/lookup/credential flow: browsed=%d lookups=%d secrets=%v variables=%v", browsed, lookups, secrets, variables)
			}
			if strings.Contains(cmd.ErrOrStderr().(*bytes.Buffer).String(), key) || strings.Contains(cmd.OutOrStdout().(*bytes.Buffer).String(), key) {
				t.Fatal("private key leaked into setup output")
			}
		})
	}
}
