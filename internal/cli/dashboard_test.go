package cli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func dashboardFixture(t *testing.T) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	data, site := filepath.Join(root, "data"), filepath.Join(root, "site")
	for _, directory := range []string{data, site} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	database := nativeTestSnapshot(t, map[string][]map[string]any{
		"repositories": {{"id": "acme/control", "repository": "acme/control", "organization": "acme"}},
	})
	content, err := os.ReadFile(database)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	for name, content := range map[string][]byte{
		"gh-aw-logs.sqlite":      content,
		"inventory-sources.json": []byte(`{"schemaVersion":1}`),
		"payload-hashes.json":    []byte(`{"gh-aw-logs.sqlite":"` + hex.EncodeToString(sum[:]) + `"}`),
	} {
		if err := os.WriteFile(filepath.Join(data, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range map[string]string{
		"index.html":     "<html><head></head><body>native preview</body></html>",
		"dashboard.json": `{"language-version":"0.1.0","dashboard":{"id":"preview","title":"Preview","pages":[{"id":"overview","title":"Overview","kind":"custom","views":[]}]}}`,
		"secret.json":    `{"token":"not-public","message":"ok"}`,
	} {
		if err := os.WriteFile(filepath.Join(site, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root, data, site
}

func TestDashboardServeOfflineNativeSQLite(t *testing.T) {
	root, data, site := dashboardFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	defer func() { _ = reader.Close(); _ = writer.Close() }()
	command := dashboardServeCommand()
	command.SetContext(ctx)
	command.SetOut(writer)
	command.SetErr(io.Discard)
	command.SetArgs([]string{"--workspace", root, "--data", data, "--site", site, "--port", "0"})
	finished := make(chan error, 1)
	go func() {
		err := command.Execute()
		_ = writer.CloseWithError(err)
		finished <- err
	}()
	line, err := bufio.NewReader(reader).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "Dashboard preview: ") {
		t.Fatalf("unexpected readiness: %q", line)
	}
	address := strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "Dashboard preview: ")), "/")
	client := &http.Client{Timeout: 5 * time.Second}
	get := func(path string) ([]byte, int) {
		t.Helper()
		response, err := client.Get(address + path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return content, response.StatusCode
	}
	content, status := get("/")
	if status != 200 || !bytes.Contains(content, []byte(`name="dashboard-storage-backend" content="sqlite"`)) {
		t.Fatalf("native page: %d %s", status, content)
	}
	content, status = get("/secret.json")
	if status != 200 || !bytes.Contains(content, []byte(`"token":"[REDACTED]"`)) {
		t.Fatalf("static secret redaction: %d %s", status, content)
	}
	queryBody := `{"sourceNames":["sample"],"queries":[{"name":"sample","from":"$repositories","select":[{"field":"repository","as":"repository"}],"limit":1}]}`
	request, err := http.NewRequestWithContext(ctx, "POST", address+"/api/v1/query", strings.NewReader(queryBody))
	if err != nil {
		t.Fatal(err)
	}
	origin := address[:strings.LastIndex(address, "/")]
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	content, err = io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !bytes.Contains(content, []byte(`"repository":"acme/control"`)) {
		t.Fatalf("native query: %d %s", response.StatusCode, content)
	}
	content, status = get("/api/v1/diagnostics")
	if status != 200 || !bytes.Contains(content, []byte(`"repositories":1`)) {
		t.Fatalf("native diagnostics: %d %s", status, content)
	}
	cancel()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".cao-dashboard-preview-") {
			t.Fatal("disposable preview data was not removed")
		}
	}
}

func TestDashboardNativeCommandsValidateWithoutExecution(t *testing.T) {
	for _, test := range []struct {
		command string
		valid   bool
	}{
		{"gh aw compile", true},
		{"gh workflow run cao-dashboard.yml --repo acme/control", true},
		{"gh agent-task create --from-file -", true},
		{"curl https://attacker.test", false},
		{"gh api --method DELETE repos/acme/control", false},
		{"gh workflow run --repo acme/control", false},
	} {
		t.Run(test.command, func(t *testing.T) {
			command := dashboardActionCommand()
			var output bytes.Buffer
			command.SetOut(&output)
			command.SetArgs([]string{"--command", test.command, "--validate"})
			err := command.Execute()
			if (err == nil) != test.valid {
				t.Fatalf("valid %v, error %v", test.valid, err)
			}
		})
	}
}

func TestDashboardAdminControlDoesNotRequireCanvasApproval(t *testing.T) {
	root, data, site := dashboardFixture(t)
	document := `{"language-version":"0.1.0","dashboard":{"id":"preview","title":"Preview","cli-actions":[{"id":"dispatch","command":"gh workflow run ci.yml --repo acme/control"}],"pages":[{"id":"overview","title":"Overview","kind":"custom","views":[]}]}}`
	if err := os.WriteFile(filepath.Join(site, "dashboard.json"), []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	input, host := io.Pipe()
	output, writer := io.Pipe()
	defer func() {
		_ = input.Close()
		_ = host.Close()
		_ = output.Close()
		_ = writer.Close()
	}()
	command := dashboardServeCommand()
	command.SetContext(ctx)
	command.SetIn(input)
	command.SetOut(writer)
	command.SetErr(io.Discard)
	command.SetArgs([]string{"--workspace", root, "--data", data, "--site", site,
		"--port", "0", "--admin", "--control-stdio", "--gh-executable", filepath.Join(root, "missing-gh")})
	finished := make(chan error, 1)
	go func() {
		err := command.Execute()
		_ = writer.CloseWithError(err)
		finished <- err
	}()
	var ready struct {
		Event string `json:"event"`
		URL   string `json:"url"`
	}
	if err := json.NewDecoder(output).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	if ready.Event != "ready" || ready.URL == "" {
		t.Fatalf("invalid readiness: %+v", ready)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		ready.URL+"/__cli_commands", strings.NewReader(`{"id":"dispatch"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", ready.URL[:strings.LastIndex(ready.URL, "/")])
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("admin command requested canvas approval: %d %s", response.StatusCode, content)
	}
	cancel()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

func TestDashboardNativeQueryTool(t *testing.T) {
	command := dashboardEvaluateCommand()
	command.SetIn(strings.NewReader(`{"queries":[{"name":"failed","from":"runs","filter":{"predicates":[{"field":"conclusion","equals":"failure"}]}}],"sources":{"runs":[{"conclusion":"failure"},{"conclusion":"success"}]}}`))
	var output bytes.Buffer
	command.SetOut(&output)
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	var result map[string]struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result["failed"].Rows) != 1 || result["failed"].Rows[0]["conclusion"] != "failure" {
		t.Fatalf("native tool result: %s", output.String())
	}
}

func TestDashboardRejectsInvalidFlagsBeforePreparation(t *testing.T) {
	for _, flags := range [][]string{
		{"--data-backend", "unknown"}, {"--port", "-1"}, {"--port", "65536"},
		{"--host", "attacker.test"}, {"--admin", "--canvas"},
		{"--admin", "--host", "0.0.0.0"}, {"--canvas", "--replace-existing"},
		{"--canvas"}, {"--command-concurrency", "0"}, {"--command-concurrency", "33"},
		{"--command-concurrency", "4"}, {"--acknowledge-command-recovery"},
		{"--policy", "policy.json"}, {"--cert", "certificate.pem"},
		{"--operational-store", "unknown"}, {"--operational-store", "memory", "--repo", "acme/control"},
		{"--operational-store", "memory", "--data-backend", "sqlite"},
	} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			command := dashboardServeCommand()
			command.SetOut(io.Discard)
			command.SetErr(io.Discard)
			command.SetArgs(append([]string{"--workspace", t.TempDir()}, flags...))
			if err := command.Execute(); err == nil {
				t.Fatal("invalid flags were accepted")
			}
		})
	}
}

func TestDashboardNativeQueryToolRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{
		`{} {}`, `{"unknown":true}`, `{"queries":`, strings.Repeat(" ", (8<<20)+1),
	} {
		command := dashboardEvaluateCommand()
		command.SetIn(strings.NewReader(input))
		command.SetOut(io.Discard)
		command.SetErr(io.Discard)
		if err := command.Execute(); err == nil {
			t.Fatal("invalid query request was accepted")
		}
	}
}

func TestDashboardHostedNativeBackendSelection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("external-command fixture uses a POSIX shell")
	}
	workspace := t.TempDir()
	executable := filepath.Join(workspace, "hosted-fixture")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" \"policy=$CAO_POLICY_PATH\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(executable, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_DASHBOARD_EXECUTABLE", executable)
	t.Setenv("CAO_POLICY_PATH", "reviewed-policy.json")
	resolvedWorkspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	for _, store := range []string{"postgres", "redis", "memory"} {
		command := dashboardServeCommand()
		var output bytes.Buffer
		command.SetOut(&output)
		command.SetErr(&output)
		command.SetArgs([]string{"--workspace", workspace, "--operational-store", store})
		if err := command.Execute(); err != nil {
			t.Fatalf("%s: %v", store, err)
		}
		if !strings.Contains(output.String(), "serve-hosted\n--operational-store\n"+store+"\n") ||
			!strings.Contains(output.String(), "policy="+filepath.Join(resolvedWorkspace, "reviewed-policy.json")) {
			t.Fatalf("%s: unexpected native invocation: %s", store, output.String())
		}
	}
	if os.Getenv("CAO_POLICY_PATH") != "reviewed-policy.json" {
		t.Fatal("hosted launcher changed the parent policy environment")
	}
}
