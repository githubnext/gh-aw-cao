package localpreview

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNativeReleaseServesEmbeddedTerminalOffline(t *testing.T) {
	repository, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	scratch := filepath.Join(repository, ".tmp")
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		t.Fatal(err)
	}
	workspace, err := os.MkdirTemp(scratch, "offline-terminal-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(workspace); err != nil {
			t.Error(err)
		}
	})
	data := fixture(t, workspace)
	write(t, data, "inventory-sources.json", `{"schemaVersion":1}`)
	for _, name := range []string{"index.html", "dashboard.json", "src"} {
		if err := os.RemoveAll(filepath.Join(data, name)); err != nil {
			t.Fatal(err)
		}
	}
	executable := filepath.Join(workspace, "cao-dashboard")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	buildCtx, buildCancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer buildCancel()
	build := exec.CommandContext(buildCtx, "go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false",
		"-ldflags=-s -w -X main.version=offline-terminal-test", "-o", executable, "./cmd/cao-dashboard") // #nosec G204 -- Fixed Go build targeting a private test executable.
	build.Dir = filepath.Join(repository, "server")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build release-style native executable: %v\n%s", err, output)
	}
	emptyPath := filepath.Join(workspace, "empty-path")
	if err := os.Mkdir(emptyPath, 0o700); err != nil {
		t.Fatal(err)
	}
	log, err := os.Create(filepath.Join(workspace, "native.log")) // #nosec G304 -- Fixed log name inside this test's private directory.
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = log.Close() }()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "serve-local",
		"--workspace", workspace, "--data", data, "--canvas", "--port", "0", "--control-stdio",
		"--gh-executable", filepath.Join(emptyPath, "missing-gh")) // #nosec G204 -- Only the executable built by this test is launched.
	command.Dir = workspace
	command.Env = []string{
		"PATH=" + emptyPath, "HOME=" + workspace, "USERPROFILE=" + workspace,
		"APPDATA=" + workspace, "LOCALAPPDATA=" + workspace,
		"TMPDIR=" + workspace, "TMP=" + workspace, "TEMP=" + workspace,
		"HTTP_PROXY=http://127.0.0.1:1", "HTTPS_PROXY=http://127.0.0.1:1",
		"NO_PROXY=localhost,127.0.0.1",
	}
	for _, key := range []string{"SYSTEMROOT", "WINDIR"} {
		if value := os.Getenv(key); value != "" {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	command.Stderr = log
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		_ = input.Close()
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		t.Fatal(err)
	}
	defer func() {
		_ = input.Close()
		if err := command.Wait(); err != nil {
			diagnostic, _ := os.ReadFile(log.Name())
			t.Errorf("native shutdown failed: %v\n%s", err, diagnostic)
		}
	}()
	line, err := bufio.NewReader(output).ReadBytes('\n')
	if err != nil {
		diagnostic, _ := os.ReadFile(log.Name())
		t.Fatalf("native startup failed: %v\n%s", err, diagnostic)
	}
	var ready struct {
		Event string `json:"event"`
		URL   string `json:"url"`
	}
	if err := json.Unmarshal(line, &ready); err != nil || ready.Event != "ready" {
		t.Fatalf("unexpected native readiness: %s (%v)", line, err)
	}
	base, err := url.Parse(ready.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	get := func(address *url.URL) string {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, address.String(), nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		content, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("native asset %s: HTTP %d", address.Path, response.StatusCode)
		}
		if strings.HasSuffix(address.Path, ".js") && !strings.Contains(response.Header.Get("Content-Type"), "javascript") {
			t.Fatalf("native asset %s is not JavaScript", address.Path)
		}
		return string(content)
	}
	runtimeURL := base.ResolveReference(&url.URL{Path: "src/components/cli-terminal-runtime.js"})
	source := get(runtimeURL)
	if strings.Contains(source, "@xterm/") || strings.Contains(source, "from 'strip-ansi'") {
		t.Fatal("native terminal source still requires npm package resolution")
	}
	expected := map[string]struct {
		minimum int
		symbol  string
	}{
		"../vendor/xterm.js":           {100_000, "Terminal"},
		"../vendor/addon-fit.js":       {1_000, "FitAddon"},
		"../vendor/addon-web-links.js": {1_000, "WebLinksAddon"},
		"../vendor/strip-ansi.js":      {1_000, "default"},
		"../vendor/xterm-css.js":       {1_000, ".xterm-screen"},
	}
	imports := regexp.MustCompile(`(?m)^import\s+.*?\s+from\s+['"]([^'"]+)['"]`).FindAllStringSubmatch(source, -1)
	for _, entry := range imports {
		reference, err := url.Parse(entry[1])
		if err != nil || !strings.HasPrefix(entry[1], ".") {
			t.Fatalf("terminal import is not a local browser module: %s", entry[1])
		}
		address := runtimeURL.ResolveReference(reference)
		if address.Host != base.Host || address.Scheme != base.Scheme {
			t.Fatalf("terminal dependency requires a network origin: %s", address)
		}
		content := get(address)
		if contract, vendor := expected[entry[1]]; vendor {
			if len(content) < contract.minimum || !strings.Contains(content, contract.symbol) ||
				!strings.Contains(content, "Copyright") {
				t.Fatalf("embedded terminal dependency %s is incomplete or lacks its license", entry[1])
			}
			t.Logf("native offline asset %s: %d bytes", entry[1], len(content))
			delete(expected, entry[1])
		}
	}
	if len(expected) != 0 {
		t.Fatalf("terminal did not load all embedded dependencies: %v", expected)
	}
	for _, name := range []string{"node_modules", "go.mod", ".git"} {
		if _, err := os.Stat(filepath.Join(workspace, name)); !os.IsNotExist(err) {
			t.Fatalf("foreign workspace unexpectedly contains %s", name)
		}
	}
}
