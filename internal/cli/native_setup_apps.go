package cli

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"
)

type nativeSetupApp struct {
	ID, ClientID, PEM, Slug, Name string
}

type nativeSetupAppAPI struct {
	base   string
	client *http.Client
}

var nativeSetupAppRegistrationTemplate = template.Must(template.New("app-registration").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Create GitHub App</title><form id="manifest-form" action="{{.Action}}" method="post"><input type="hidden" name="manifest" value="{{.Manifest}}"><button type="submit">Continue to GitHub App creation</button></form><script>document.getElementById("manifest-form").submit();</script></html>`))

func nativeSetupNewAppAPI() (nativeSetupAppAPI, error) {
	server, err := nativeSetupServerURL()
	if err != nil {
		return nativeSetupAppAPI{}, err
	}
	api := strings.TrimRight(strings.TrimSpace(os.Getenv("GITHUB_API_URL")), "/")
	if api == "" {
		parsed, _ := url.Parse(server)
		switch {
		case parsed.Hostname() == "github.com":
			api = "https://api.github.com"
		case strings.HasSuffix(parsed.Hostname(), ".ghe.com"):
			api = "https://api." + parsed.Hostname()
		default:
			api = server + "/api/v3"
		}
	}
	parsed, err := url.Parse(api)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nativeSetupAppAPI{}, errors.New("invalid GitHub API URL")
	}
	return nativeSetupAppAPI{
		base: api,
		client: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}, nil
}

func nativeSetupAppJWT(app nativeSetupApp, now time.Time) (string, error) {
	block, _ := pem.Decode([]byte(app.PEM))
	if block == nil {
		return "", errors.New("invalid GitHub App private key")
	}
	var key *rsa.PrivateKey
	if parsed, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		key = parsed
	} else if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		key, _ = parsed.(*rsa.PrivateKey)
	}
	if key == nil || app.ClientID == "" {
		return "", errors.New("GitHub App client ID and RSA private key are required")
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{"iat": now.Unix() - 60, "exp": now.Unix() - 60 + 9*60, "iss": app.ClientID})
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", errors.New("unable to sign GitHub App authentication")
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (api nativeSetupAppAPI) request(ctx context.Context, method, path, token string, body any, result any) (status int, err error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, api.base+path, reader)
	if err != nil {
		return 0, errors.New("unable to construct GitHub App request")
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := api.client.Do(req)
	if err != nil {
		// Do not include remote response bodies, transport credentials, or JWTs.
		return 0, errors.New("GitHub App request failed")
	}
	defer func() { err = errors.Join(err, response.Body.Close()) }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("GitHub App request failed with HTTP %d", response.StatusCode)
	}
	if result != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, 16<<20))
		decoder.UseNumber()
		if decoder.Decode(result) != nil {
			return response.StatusCode, errors.New("GitHub returned invalid App response JSON")
		}
	}
	return response.StatusCode, nil
}

func nativeSetupAppManifest(name, homepage, redirect, description string, permissions map[string]string) map[string]any {
	return map[string]any{
		"name": name, "url": homepage, "hook_attributes": map[string]any{"url": homepage, "active": false},
		"redirect_url": redirect, "public": false, "request_oauth_on_install": false,
		"description": description, "default_permissions": permissions, "default_events": []string{},
	}
}

func nativeSetupAppDescription(repo string, profile nativeSetupCredential) string {
	if profile.Role == "hosted-cli" {
		return "Central Agentic Ops hosted CLI executor for " + repo + ". Single-use repository tokens only."
	}
	return "Central Agentic Ops " + profile.Label + " App for " + repo
}

func nativeSetupAppName(repo, role string) string {
	name := "cao-" + strings.ReplaceAll(strings.ToLower(repo), "/", "-")
	name = regexp.MustCompile(`[^a-z0-9-]`).ReplaceAllString(name, "-")
	limit := 34 - len(role) - 1
	if len(name) > limit {
		name = name[:limit]
	}
	return strings.TrimRight(name, "-") + "-" + role
}

func nativeSetupValidateAppName(name string) error {
	if len(name) > 34 || !regexp.MustCompile(`^[A-Za-z0-9-]+$`).MatchString(name) {
		return nativeErrorf("App name must contain only letters, numbers, or hyphens and be at most 34 characters")
	}
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "github") || strings.HasPrefix(lower, "gist") {
		return nativeErrorf("App name must not begin with GitHub or Gist")
	}
	return nil
}

func nativeSetupAppInstallURL(server, owner, slug string) string {
	parsed, _ := url.Parse(server)
	if strings.HasSuffix(parsed.Hostname(), ".ghe.com") {
		return server + "/organizations/" + owner + "/settings/apps/" + slug + "/installations"
	}
	return server + "/apps/" + slug + "/installations/new"
}

func nativeSetupCreateApp(cmd *cobra.Command, gh ghExecutor, owner, name, homepage string, profile nativeSetupCredential, noOpen bool) (app nativeSetupApp, err error) {
	serverURL, err := nativeSetupServerURL()
	if err != nil {
		return nativeSetupApp{}, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nativeSetupApp{}, err
	}
	defer func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			err = errors.Join(err, closeErr)
		}
	}()
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return nativeSetupApp{}, err
	}
	state := hex.EncodeToString(stateBytes)
	localURL := "http://" + listener.Addr().String()
	manifest := nativeSetupAppManifest(name, homepage, localURL+"/callback", nativeSetupAppDescription(strings.TrimPrefix(homepage, serverURL+"/"), profile), profile.Permissions)
	data, _ := json.Marshal(manifest)
	registrationURL := serverURL + "/organizations/" + owner + "/settings/apps/new?state=" + state
	// This browser-only form is the GitHub App manifest protocol, not a CLI
	// JavaScript runtime. The noscript button supports JavaScript-free browsers.
	var page bytes.Buffer
	if err := nativeSetupAppRegistrationTemplate.Execute(&page, struct{ Action, Manifest string }{registrationURL, string(data)}); err != nil {
		return nativeSetupApp{}, errors.New("unable to prepare GitHub App registration page")
	}
	type outcome struct {
		app nativeSetupApp
		err error
	}
	completed := make(chan outcome, 1)
	var once sync.Once
	finish := func(app nativeSetupApp, err error) { once.Do(func() { completed <- outcome{app, err} }) }
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if req.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if req.URL.Path == "/register" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if _, err := fmt.Fprint(w, page.String()); err != nil {
				finish(nativeSetupApp{}, errors.New("unable to serve GitHub App registration page"))
			}
			return
		}
		if req.URL.Path != "/callback" {
			http.NotFound(w, req)
			return
		}
		code := req.URL.Query().Get("code")
		if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(code) || req.URL.Query().Get("state") != state {
			http.Error(w, "Invalid manifest callback code or state.", http.StatusBadRequest)
			finish(nativeSetupApp{}, errors.New("invalid GitHub App manifest callback code or state"))
			return
		}
		out, _, conversionErr := gh(cmd.Context(), "api", "-X", "POST", "-H", "Accept: application/vnd.github+json", "/app-manifests/"+code+"/conversions")
		if conversionErr != nil {
			http.Error(w, "Manifest exchange failed.", http.StatusInternalServerError)
			finish(nativeSetupApp{}, errors.New("GitHub App manifest conversion failed"))
			return
		}
		var payload struct {
			ID       json.Number `json:"id"`
			ClientID string      `json:"client_id"`
			PEM      string      `json:"pem"`
			Slug     string      `json:"slug"`
			Name     string      `json:"name"`
		}
		if json.Unmarshal([]byte(out), &payload) != nil || payload.ClientID == "" || payload.PEM == "" || payload.Slug == "" {
			http.Error(w, "Incomplete manifest conversion.", http.StatusInternalServerError)
			finish(nativeSetupApp{}, errors.New("GitHub returned an incomplete App manifest conversion"))
			return
		}
		app := nativeSetupApp{ID: payload.ID.String(), ClientID: payload.ClientID, PEM: payload.PEM, Slug: payload.Slug, Name: payload.Name}
		http.Redirect(w, req, nativeSetupAppInstallURL(serverURL, owner, app.Slug), http.StatusFound)
		finish(app, nil)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			finish(nativeSetupApp{}, errors.New("GitHub App callback server failed"))
		}
	}()
	defer func() { err = errors.Join(err, server.Close()) }()
	if err := nativeSetupNote(cmd, "Create private GitHub App for %s:\n- name: %s\n- homepage: %s\n- public: no\n- webhook events: none\n", owner, name, homepage); err != nil {
		return nativeSetupApp{}, err
	}
	for _, permission := range nativeSetupSortedPermissions(profile.Permissions) {
		if err := nativeSetupNote(cmd, "  - %s: %s\n", permission, profile.Permissions[permission]); err != nil {
			return nativeSetupApp{}, err
		}
	}
	if err := nativeSetupOpen(cmd, gh, localURL+"/register", noOpen); err != nil {
		return nativeSetupApp{}, err
	}
	timer := time.NewTimer(10 * time.Minute)
	defer timer.Stop()
	select {
	case result := <-completed:
		return result.app, result.err
	case <-timer.C:
		return nativeSetupApp{}, errors.New("timed out waiting for GitHub App creation in the browser")
	case <-cmd.Context().Done():
		return nativeSetupApp{}, cmd.Context().Err()
	}
}

func nativeSetupPrivateKey(cmd *cobra.Command, label string) (result string, err error) {
	input, ok := cmd.InOrStdin().(*os.File)
	output, outOK := cmd.ErrOrStderr().(*os.File)
	if !ok || !outOK || !term.IsTerminal(int(input.Fd())) || !term.IsTerminal(int(output.Fd())) {
		return "", errors.New("reusing an App requires an interactive terminal to enter its private key securely")
	}
	if err := nativeSetupNote(cmd, "Enter the %s App PEM private key (hidden; finish with its END line):\n", label); err != nil {
		return "", err
	}
	defer func() { err = errors.Join(err, nativeSetupNote(cmd, "\n")) }()
	var key strings.Builder
	for key.Len() <= 64<<10 {
		line, err := term.ReadPassword(int(input.Fd()))
		if err != nil {
			return "", nativeErrorf("App private-key entry cancelled or ended before its END line")
		}
		key.Write(line)
		key.WriteByte('\n')
		if string(line) == "-----END PRIVATE KEY-----" || string(line) == "-----END RSA PRIVATE KEY-----" {
			return key.String(), nil
		}
	}
	return "", nativeErrorf("App private key exceeds the supported size")
}

func nativeSetupAuthenticateApp(ctx context.Context, api nativeSetupAppAPI, app nativeSetupApp, profile nativeSetupCredential) (nativeSetupApp, error) {
	jwt, err := nativeSetupAppJWT(app, time.Now())
	if err != nil {
		return app, err
	}
	var payload struct {
		ID          json.Number       `json:"id"`
		ClientID    string            `json:"client_id"`
		Slug        string            `json:"slug"`
		Name        string            `json:"name"`
		Public      *bool             `json:"public"`
		Permissions map[string]string `json:"permissions"`
	}
	if _, err := api.request(ctx, "GET", "/app", jwt, nil, &payload); err != nil {
		return app, err
	}
	if payload.ClientID != app.ClientID || payload.ID == "" || payload.Slug == "" || payload.Public == nil || *payload.Public {
		return app, errors.New("credentials must identify the selected private GitHub App")
	}
	for permission, level := range profile.Permissions {
		actual := payload.Permissions[permission]
		if actual != level && (profile.Role != "write" || level != "read" || actual != "write") {
			return app, fmt.Errorf("%s App requires %s: %s", profile.Label, permission, level)
		}
	}
	for permission, level := range payload.Permissions {
		if profile.Role == "hosted-cli" && profile.Permissions[permission] != level {
			return app, fmt.Errorf("%s App has an unsupported permission: %s: %s", profile.Label, permission, level)
		}
		if level != "read" && profile.Permissions[permission] != level {
			return app, fmt.Errorf("%s App has an unsupported permission: %s: %s", profile.Label, permission, level)
		}
	}
	app.ID, app.Slug, app.Name = payload.ID.String(), payload.Slug, payload.Name
	return app, nil
}

type nativeSetupInstallation struct {
	ID        json.Number            `json:"id"`
	AppID     json.Number            `json:"app_id"`
	Selection string                 `json:"repository_selection"`
	Account   struct{ Login string } `json:"account"`
}

func (api nativeSetupAppAPI) installation(ctx context.Context, app nativeSetupApp, owner string) (*nativeSetupInstallation, error) {
	jwt, err := nativeSetupAppJWT(app, time.Now())
	if err != nil {
		return nil, err
	}
	var result nativeSetupInstallation
	status, err := api.request(ctx, "GET", "/orgs/"+owner+"/installation", jwt, nil, &result)
	if status == 404 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if result.ID == "" || result.AppID.String() != app.ID || !strings.EqualFold(result.Account.Login, owner) {
		return nil, errors.New("GitHub returned an unexpected App installation identity")
	}
	return &result, nil
}

var errNativeSetupInstallationScope = errors.New("GitHub App is installed for all repositories; select only approved repositories")

func (api nativeSetupAppAPI) covers(ctx context.Context, app nativeSetupApp, target nativeSetupOwnerGroup) (*nativeSetupInstallation, error) {
	installation, err := api.installation(ctx, app, target.Owner)
	if err != nil || installation == nil {
		return nil, err
	}
	if installation.Selection != "selected" {
		return nil, errNativeSetupInstallationScope
	}
	selected, err := api.installationRepositories(ctx, app, installation.ID.String())
	if err != nil {
		return nil, err
	}
	for _, name := range target.Repositories {
		if !selected[strings.ToLower(target.Owner+"/"+name)] {
			return nil, nil
		}
	}
	return installation, nil
}

func (api nativeSetupAppAPI) installationRepositories(ctx context.Context, app nativeSetupApp, installationID string) (map[string]bool, error) {
	jwt, err := nativeSetupAppJWT(app, time.Now())
	if err != nil {
		return nil, err
	}
	var access struct{ Token string }
	if _, err := api.request(ctx, "POST", "/app/installations/"+installationID+"/access_tokens", jwt, map[string]any{"permissions": map[string]string{"metadata": "read"}}, &access); err != nil {
		return nil, err
	}
	if access.Token == "" {
		return nil, errors.New("GitHub returned an incomplete installation access token")
	}
	selected := map[string]bool{}
	for page := 1; ; page++ {
		var payload struct {
			Total        int `json:"total_count"`
			Repositories []struct {
				FullName string `json:"full_name"`
			} `json:"repositories"`
		}
		if _, err := api.request(ctx, "GET", fmt.Sprintf("/installation/repositories?per_page=100&page=%d", page), access.Token, nil, &payload); err != nil {
			return nil, err
		}
		for _, repo := range payload.Repositories {
			if repo.FullName != "" {
				selected[strings.ToLower(repo.FullName)] = true
			}
		}
		if len(payload.Repositories) < 100 || (payload.Total > 0 && len(selected) >= payload.Total) {
			break
		}
		if page >= 10000 {
			return nil, nativeErrorf("App selected repository verification exceeded its bound")
		}
	}
	return selected, nil
}

func nativeSetupPause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func nativeSetupEnsureInstallations(cmd *cobra.Command, gh ghExecutor, api nativeSetupAppAPI, app nativeSetupApp, targets []nativeSetupOwnerGroup, noOpen, firstOpen bool) error {
	server, err := nativeSetupServerURL()
	if err != nil {
		return err
	}
	for index, target := range targets {
		installation, err := api.covers(cmd.Context(), app, target)
		if err != nil {
			return err
		}
		if installation != nil {
			if err := nativeSetupNote(cmd, "Selected-repository GitHub App installation %s already covers %s; skipping.\n", installation.ID, target.Owner); err != nil {
				return err
			}
			continue
		}
		if !firstOpen || index != 0 {
			address := nativeSetupAppInstallURL(server, target.Owner, app.Slug)
			existing, err := api.installation(cmd.Context(), app, target.Owner)
			if err != nil {
				return err
			}
			if existing != nil {
				address = server + "/organizations/" + target.Owner + "/settings/installations/" + existing.ID.String()
			}
			if err := nativeSetupOpen(cmd, gh, address, noOpen); err != nil {
				return err
			}
		}
		if err := nativeSetupNote(cmd, "Install %s on %s. Choose Only select repositories; select %s and save.\n", app.Name, target.Owner, strings.Join(target.Repositories, ", ")); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Minute)
		var lastErr error
		for {
			installation, lastErr = api.covers(ctx, app, target)
			if errors.Is(lastErr, errNativeSetupInstallationScope) {
				cancel()
				return lastErr
			}
			if installation != nil && lastErr == nil {
				break
			}
			if err := nativeSetupPause(ctx, 5*time.Second); err != nil {
				cancel()
				if lastErr != nil {
					return fmt.Errorf("timed out waiting for GitHub App installation on %s: %w", target.Owner, lastErr)
				}
				return fmt.Errorf("timed out waiting for GitHub App installation on %s", target.Owner)
			}
		}
		cancel()
	}
	return nil
}

func nativeSetupRepositoryState(cmd *cobra.Command, gh ghExecutor, repo string) (map[string]bool, map[string]bool, error) {
	variables := map[string]bool{}
	secrets := map[string]bool{}
	for _, item := range []struct {
		name, query string
		target      map[string]bool
	}{{"variables", ".variables[].name", variables}, {"secrets", ".secrets[].name", secrets}} {
		out, err := nativeSetupGH(cmd, gh, "api", "/repos/"+repo+"/actions/"+item.name+"?per_page=100", "--paginate", "--jq", item.query)
		if err != nil {
			return nil, nil, err
		}
		for _, name := range strings.Split(out, "\n") {
			if name != "" {
				item.target[name] = true
			}
		}
	}
	return variables, secrets, nil
}

func nativeSetupGitHubApps(cmd *cobra.Command, gh ghExecutor, options nativeSetupAuthOptions, read []string) (map[string]any, error) {
	if (options.readClient == "") != (options.writeClient == "") {
		return nil, errors.New("--read-client-id and --write-client-id must be supplied together")
	}
	if options.readClient != "" && (options.force || options.readName != "" || options.writeName != "") {
		return nil, errors.New("existing App client IDs cannot be combined with --force or App names")
	}
	if options.readClient != "" && options.readClient == options.writeClient {
		return nil, errors.New("read and write App client IDs must be distinct")
	}
	owner := strings.Split(options.repo, "/")[0]
	if strings.HasSuffix(owner, "-") {
		return nil, errors.New("invalid repository owner")
	}
	targets := map[string][]nativeSetupOwnerGroup{"read": nativeSetupGroups(read, options.repo, true), "write": nativeSetupGroups(options.write, options.repo, true)}
	for _, groups := range targets {
		for _, group := range groups {
			if !strings.EqualFold(group.Owner, owner) && options.readClient == "" {
				return nil, fmt.Errorf("private organization-owned Apps cannot be installed on %s; configure existing enterprise-owned Apps or a fine-grained token", group.Owner)
			}
		}
	}
	names := map[string]string{"read": options.readName, "write": options.writeName}
	for _, role := range []string{"read", "write"} {
		if names[role] == "" {
			names[role] = nativeSetupAppName(options.repo, role)
		}
		if err := nativeSetupValidateAppName(names[role]); err != nil {
			return nil, err
		}
	}
	if strings.EqualFold(names["read"], names["write"]) {
		return nil, errors.New("read and write App names must be distinct")
	}
	server, err := nativeSetupServerURL()
	if err != nil {
		return nil, err
	}
	homepage := server + "/" + options.repo
	if options.dryRun {
		apps := []map[string]any{}
		for _, profile := range nativeSetupCredentials(false) {
			app := map[string]any{"role": profile.Role, "variable": profile.Variable, "secret": profile.Secret}
			if options.readClient != "" {
				id := options.readClient
				if profile.Role == "write" {
					id = options.writeClient
				}
				app["clientId"], app["permissions"] = id, profile.Permissions
			} else {
				app["manifest"] = nativeSetupAppManifest(names[profile.Role], homepage, "http://127.0.0.1:0/callback", "Central Agentic Ops "+profile.Label+" App for "+options.repo, profile.Permissions)
			}
			apps = append(apps, app)
		}
		return map[string]any{"repo": options.repo, "installationTargets": targets, "apps": apps}, nil
	}
	if _, err := nativeSetupGH(cmd, gh, "auth", "status"); err != nil {
		return nil, err
	}
	canonical, err := nativeSetupGH(cmd, gh, "repo", "view", options.repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner")
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(canonical, options.repo) {
		return nil, errors.New("repository resolved to unexpected slug")
	}
	if _, err := nativeSetupGH(cmd, gh, "api", "/users/"+owner, "--jq", ".login"); err != nil {
		return nil, err
	}
	variables, secrets, err := nativeSetupRepositoryState(cmd, gh, options.repo)
	if err != nil {
		return nil, err
	}
	api, err := nativeSetupNewAppAPI()
	if err != nil {
		return nil, err
	}
	for _, profile := range nativeSetupCredentials(false) {
		complete := variables[profile.Variable] && secrets[profile.Secret]
		var app nativeSetupApp
		created := options.readClient == "" && (!complete || options.force)
		if !created {
			id := options.readClient
			if profile.Role == "write" {
				id = options.writeClient
			}
			if id == "" {
				id, err = nativeSetupGH(cmd, gh, "api", "/repos/"+options.repo+"/actions/variables/"+profile.Variable, "--jq", ".value")
				if err != nil {
					return nil, err
				}
			}
			key, err := nativeSetupPrivateKey(cmd, profile.Label)
			if err != nil {
				return nil, err
			}
			app, err = nativeSetupAuthenticateApp(cmd.Context(), api, nativeSetupApp{ClientID: id, PEM: key}, profile)
			if err != nil {
				return nil, err
			}
		} else {
			app, err = nativeSetupCreateApp(cmd, gh, owner, names[profile.Role], server+"/"+canonical, profile, options.noOpen)
			if err != nil {
				return nil, err
			}
		}
		if err := nativeSetupEnsureInstallations(cmd, gh, api, app, targets[profile.Role], options.noOpen, created); err != nil {
			return nil, err
		}
		if _, err := nativeSetupGH(cmd, gh, "variable", "set", profile.Variable, "--repo", options.repo, "--body", app.ClientID); err != nil {
			return nil, err
		}
		if _, err := nativeSetupExec(cmd, "gh", strings.NewReader(app.PEM), "secret", "set", profile.Secret, "--repo", options.repo); err != nil {
			return nil, errors.New("GitHub App private-key setup failed")
		}
		if profile.Role == "read" {
			if _, err := nativeSetupGH(cmd, gh, "variable", "set", "GH_AW_GITHUB_AUTH_MODE", "--repo", options.repo, "--body", "app"); err != nil {
				return nil, err
			}
		}
	}
	variables, secrets, err = nativeSetupRepositoryState(cmd, gh, options.repo)
	if err != nil {
		return nil, err
	}
	for _, profile := range nativeSetupCredentials(false) {
		if !variables[profile.Variable] || !secrets[profile.Secret] {
			return nil, fmt.Errorf("credential verification failed for the %s App", profile.Label)
		}
	}
	return map[string]any{"command": "setup-auth", "profile": "github-app"}, nil
}
