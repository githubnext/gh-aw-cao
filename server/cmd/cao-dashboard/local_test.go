package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
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
	databasePath := filepath.Join(data, "gh-aw-logs.sqlite")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.ExecContext(t.Context(), `CREATE TABLE __idb_records (database_name TEXT, store_name TEXT, record_key TEXT, value TEXT, PRIMARY KEY(database_name,store_name,record_key));
INSERT INTO __idb_records VALUES ('gh-aw-cao-dashboard-data','repositories','"acme/control"','{"id":"acme/control","repository":"acme/control","organization":"acme"}');`)
	if closeErr := database.Close(); err != nil || closeErr != nil {
		t.Fatalf("create canonical fixture: %v %v", err, closeErr)
	}
	content, err := os.ReadFile(databasePath) // #nosec G304 -- Canonical snapshot created inside this test's private directory.
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
	for name, content := range map[string]string{ // #nosec G101 -- Deliberate non-secret input to the redaction regression test.
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
	command := newServeLocalCommand()
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
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, address+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
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
	command := newServeLocalCommand()
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
			command := newServeLocalCommand()
			command.SetOut(io.Discard)
			command.SetErr(io.Discard)
			command.SetArgs(append([]string{"--workspace", t.TempDir()}, flags...))
			if err := command.Execute(); err == nil {
				t.Fatal("invalid flags were accepted")
			}
		})
	}
}
