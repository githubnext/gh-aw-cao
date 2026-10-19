package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func localTestServer(t *testing.T) (*LocalServer, *httptest.Server) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"index.html":              "<html><head></head><body>preview</body></html>",
		"data.json":               `{"token":"secret","message":"` + strings.Repeat("x", 2048) + `"}`,
		"private":                 "not public",
		"compiler-overrides.json": `{"private":true}`,
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	local, err := NewLocalServer(t.Context(), LocalConfig{
		Listen: "127.0.0.1:0", Workspace: root, SiteDirectory: root, OverlayDirectory: root,
		Prefix: "/" + strings.Repeat("a", 48), Canvas: true, QueryDesigner: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(local.Handler())
	local.authority = strings.TrimPrefix(server.URL, "http://")
	t.Cleanup(server.Close)
	return local, server
}

func TestLocalCapabilityHostAndOrigin(t *testing.T) {
	local, server := localTestServer(t)
	for _, test := range []struct {
		name, method, path, host, origin, contentType string
		want                                          int
	}{
		{"missing capability", "GET", "/index.html", "", "", "", 404},
		{"wrong capability", "GET", "/" + strings.Repeat("b", 48) + "/", "", "", "", 404},
		{"wrong host", "GET", local.config.Prefix + "/", "attacker.test", "", "", 400},
		{"missing origin", "POST", local.config.Prefix + "/__query_designer", "", "", "application/json", 403},
		{"foreign origin", "POST", local.config.Prefix + "/__query_designer", "", "https://attacker.test", "application/json", 403},
		{"wrong origin scheme", "POST", local.config.Prefix + "/__query_designer", "", strings.Replace(server.URL, "http:", "https:", 1), "application/json", 403},
		{"wrong media type", "POST", local.config.Prefix + "/__query_designer", "", server.URL, "application/json-invalid", 403},
		{"same origin", "POST", local.config.Prefix + "/__query_designer", "", server.URL, "application/json; charset=utf-8", 503},
		{"wrong method", "GET", local.config.Prefix + "/__query_designer", "", "", "", 405},
		{"disabled route", "POST", local.config.Prefix + "/__query_designer/enhance", "", "", "application/json", 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(t.Context(), test.method, server.URL+test.path, strings.NewReader(`{}`))
			request.Host = local.authority
			if test.host != "" {
				request.Host = test.host
			}
			request.URL.Scheme, request.URL.Host = "", ""
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Content-Type", test.contentType)
			response := httptest.NewRecorder()
			local.Handler().ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status %d, want %d: %s", response.Code, test.want, response.Body)
			}
		})
	}
}

func TestLocalStaticCompressionRedactionAndContainment(t *testing.T) {
	local, server := localTestServer(t)
	outside := filepath.Join(t.TempDir(), "escape.json")
	if err := os.WriteFile(outside, []byte(`{"private":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(local.config.SiteDirectory, "escape.json")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/private", "/escape.json", "/compiler-overrides.json"} {
		request := httptest.NewRequestWithContext(t.Context(), "GET", local.config.Prefix+path, nil)
		request.Host = local.authority
		response := httptest.NewRecorder()
		local.Handler().ServeHTTP(response, request)
		if response.Code != 404 {
			t.Fatalf("%s: status %d", path, response.Code)
		}
	}
	request := httptest.NewRequestWithContext(t.Context(), "GET", local.config.Prefix+"/data.json", nil)
	request.Host = local.authority
	request.Header.Set("Accept-Encoding", "gzip")
	response := httptest.NewRecorder()
	local.Handler().ServeHTTP(response, request)
	if response.Code != 200 || response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("compression response: %d %v", response.Code, response.Header())
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(content, []byte(`"token":"[REDACTED]"`)) || bytes.Contains(content, []byte(`"secret"`)) {
		t.Fatalf("secret was not redacted")
	}
	request = httptest.NewRequestWithContext(t.Context(), "HEAD", local.config.Prefix+"/data.json", nil)
	request.Host = local.authority
	response = httptest.NewRecorder()
	local.Handler().ServeHTTP(response, request)
	if response.Code != 200 || response.Body.Len() != 0 {
		t.Fatalf("HEAD response: %d %q", response.Code, response.Body.String())
	}
	request = httptest.NewRequestWithContext(t.Context(), "GET", server.URL+local.config.Prefix+"/?local-preview=canvas", nil)
	request.RequestURI = ""
	result, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = result.Body.Close() }()
	html, err := io.ReadAll(result.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(html, []byte(`name="dashboard-github-api-base"`)) {
		t.Fatal("missing local GitHub configuration")
	}
}

func TestLocalBridgeCancellationAndDisconnect(t *testing.T) {
	input, writer := io.Pipe()
	output, requests := io.Pipe()
	bridge := NewLocalBridge(input, requests, nil)
	defer func() {
		_ = writer.Close()
		_ = input.Close()
		_ = requests.Close()
		_ = output.Close()
	}()
	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() { result <- bridge.Call(ctx, "query.generate", map[string]any{}, nil) }()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() {
		t.Fatal("missing RPC request")
	}

	var request struct {
		ID uint64 `json:"id"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
		t.Fatal(err)
	}
	cancel()
	if !scanner.Scan() || !bytes.Contains(scanner.Bytes(), []byte(`"cancel":`)) {
		t.Fatal("missing cancellation")
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-bridge.done:
	case <-time.After(time.Second):
		t.Fatal("bridge did not stop on EOF")
	}
	if err := bridge.Call(t.Context(), "query.generate", nil, nil); err == nil {
		t.Fatal("disconnected bridge accepted a request")
	}
}

func TestLocalStaticMetadataPreservesHTML(t *testing.T) {
	local, _ := localTestServer(t)
	original := `<html><head><meta name="dashboard-data-backend" content="old">` +
		`<meta name="dashboard-github-api-base" content="/old/">` +
		`<meta name="cao-url" content="https://original.example/">` +
		`<style>` + strings.Repeat(".retained{color:red}", 100) + `</style></head><body>retained body</body></html>`
	if err := os.WriteFile(filepath.Join(local.config.SiteDirectory, "index.html"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), "GET", local.config.Prefix+"/?local-preview=canvas", nil)
	request.Host = local.authority
	response := httptest.NewRecorder()
	local.Handler().ServeHTTP(response, request)
	content := response.Body.String()
	if strings.Count(content, `name="dashboard-github-api-base"`) != 1 ||
		strings.Contains(content, `name="dashboard-data-backend"`) ||
		!strings.Contains(content, `<style>`+strings.Repeat(".retained{color:red}", 100)+`</style>`) ||
		!strings.Contains(content, `<body>retained body</body>`) ||
		!strings.Contains(content, `name="cao-url" content="https://original.example/"`) {
		t.Fatal("metadata injection duplicated configuration or corrupted the original HTML")
	}
}

func TestLocalSocketRejectsCommandsAndUnmaskedFrames(t *testing.T) {
	for _, frame := range [][]byte{
		{0x81, 0x80, 0, 0, 0, 0},
		{0x89, 0},
		{0x89, 0xfe},
		{0x09, 0x80, 0, 0, 0, 0},
	} {
		if _, _, err := readLocalFrame(bufio.NewReader(bytes.NewReader(frame))); err == nil {
			t.Fatalf("accepted invalid frame %x", frame)
		}
	}
	opcode, content, err := readLocalFrame(bufio.NewReader(bytes.NewReader([]byte{0x89, 0x81, 1, 2, 3, 4, 'p' ^ 1})))
	if err != nil || opcode != 9 || string(content) != "p" {
		t.Fatalf("ping frame: opcode %d payload %q error %v", opcode, content, err)
	}
}
