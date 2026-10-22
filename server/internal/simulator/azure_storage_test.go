package simulator

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Use the same official emulator image as scripts/azure-local/azure-local.sh.
const setupAzuriteImage = "mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5"

type azureBlobStore struct {
	endpoint string
	key      []byte
	client   *http.Client
}

func startSetupAzurite(t *testing.T, ctx context.Context) *azureBlobStore {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	account := "AZURITE_ACCOUNTS=stcaosetupsim:" + base64.StdEncoding.EncodeToString(key)
	var port string
	if binary := os.Getenv("CAO_SETUP_AZURITE_BINARY"); binary != "" {
		port = startSetupAzuriteProcess(t, ctx, binary, account)
	} else {
		host := setupDockerHost(t, ctx)
		env := setupAzureEnvironment(setupAzureToolEnvironment("PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "DOCKER_CONFIG"), map[string]string{
			"DOCKER_CONTEXT": "", "DOCKER_HOST": host, "DOCKER_TLS_VERIFY": "", "DOCKER_CERT_PATH": "",
			"AZURITE_ACCOUNTS": strings.TrimPrefix(account, "AZURITE_ACCOUNTS="),
		})
		docker := func(ctx context.Context, args ...string) string {
			return bootstrapRun(t, ctx, ".", env, "docker", append([]string{"--host", host}, args...)...)
		}
		docker(ctx, "image", "inspect", setupAzuriteImage, "--format", "{{.Id}}")
		network := strings.TrimSpace(docker(ctx, "network", "create", "--internal", "cao-setup-"+rand.Text()))
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			docker(cleanup, "network", "rm", network)
		})
		id := strings.TrimSpace(docker(ctx, "run", "--pull=never", "--detach", "--rm",
			"--env", "AZURITE_ACCOUNTS", "--network", network, setupAzuriteImage,
			"azurite-blob", "--blobHost", "127.0.0.1", "--silent"))
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			docker(cleanup, "rm", "--force", id)
		})
		// Docker does not publish ports on an internal-only network. Relay over
		// the validated local Unix socket instead of granting container egress.
		port = startSetupAzuriteRelay(t, ctx, func(ctx context.Context) *exec.Cmd {
			command := exec.CommandContext(ctx, "docker", "--host", host, "exec", "--interactive", id, "node", "-e", setupAzuriteRelayScript, "10000") // #nosec G204 -- local Docker socket, test-owned container, and fixed container-loopback relay.
			command.Env = env
			return command
		})
	}
	if !strings.HasPrefix(port, "127.0.0.1:") || strings.ContainsAny(port, "\r\n") {
		t.Fatalf("Azurite did not bind one numeric-loopback endpoint: %q", port)
	}
	endpoint := "http://" + port + "/stcaosetupsim"
	transport, err := NewLocalTransport(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	store := &azureBlobStore{
		endpoint: endpoint,
		key:      key,
		client:   &http.Client{Transport: transport, Timeout: 5 * time.Second},
	}
	t.Cleanup(store.client.CloseIdleConnections)
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	for {
		_, err := store.request(ctx, http.MethodPut, "/setup?restype=container", nil)
		if err == nil {
			return store
		}
		select {
		case <-ctx.Done():
			t.Fatalf("start Azurite: %v", ctx.Err())
		case <-deadline.C:
			t.Fatalf("Azurite was not ready: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func setupDockerHost(t *testing.T, ctx context.Context) string {
	t.Helper()
	host := os.Getenv("DOCKER_HOST")
	if selected := os.Getenv("DOCKER_CONTEXT"); selected != "" || host == "" {
		args := []string{"context", "inspect", "--format", "{{.Endpoints.docker.Host}}"}
		if selected != "" {
			args = append(args, "--", selected)
		}
		environment := setupAzureToolEnvironment("PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST")
		host = strings.TrimSpace(bootstrapRun(t, ctx, ".", environment, "docker", args...))
	}
	if !validSetupDockerHost(host) {
		t.Fatal("Azure simulation requires a local Unix Docker socket; remote Docker endpoints are forbidden; use CAO_SETUP_AZURITE_BINARY instead")
	}
	return host
}

func validSetupDockerHost(host string) bool {
	endpoint, err := url.Parse(host)
	return err == nil && endpoint.Scheme == "unix" && endpoint.Host == "" && endpoint.User == nil &&
		endpoint.RawQuery == "" && endpoint.Fragment == "" && filepath.IsAbs(endpoint.Path)
}

func startSetupAzuriteProcess(t *testing.T, ctx context.Context, binary, account string) string {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0") // #nosec G102 -- numeric loopback only.
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	command := exec.CommandContext(ctx, binary, "--blobHost", "127.0.0.1", "--blobPort", port, "--location", directory, "--silent") // #nosec G204,G702 -- explicitly selected official emulator, loopback-only test arguments.
	command.Dir = directory
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + directory, account, "DO_NOT_TRACK=1",
		"HTTPS_PROXY=http://127.0.0.1:1", "HTTP_PROXY=http://127.0.0.1:1", "ALL_PROXY=http://127.0.0.1:1",
		"https_proxy=http://127.0.0.1:1", "http_proxy=http://127.0.0.1:1", "all_proxy=http://127.0.0.1:1"}
	log, err := os.OpenFile(filepath.Join(directory, "azurite.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600) // #nosec G304 -- fixed log filename in t.TempDir.
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = log.Close() })
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Error(err)
		}
		_ = command.Wait()
	})
	return address
}

func (s *azureBlobStore) request(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, s.endpoint+path, bytes.NewReader(body)) // #nosec G704 -- NewLocalTransport confines the request to the emulator's numeric-loopback endpoint.
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-ms-date", time.Now().UTC().Format(http.TimeFormat))
	request.Header.Set("x-ms-version", "2021-12-02")
	headers := ""
	if method == http.MethodPut && !strings.Contains(path, "?") {
		request.Header.Set("x-ms-blob-type", "BlockBlob")
		headers = "x-ms-blob-type:BlockBlob\n"
	}
	headers += "x-ms-date:" + request.Header.Get("x-ms-date") + "\nx-ms-version:2021-12-02\n"
	length := ""
	if len(body) > 0 {
		length = fmt.Sprint(len(body))
	}
	resource := "/stcaosetupsim" + request.URL.Path
	if request.URL.Query().Get("restype") != "" {
		resource += "\nrestype:" + request.URL.Query().Get("restype")
	}
	signature := hmac.New(sha256.New, s.key)
	_, _ = fmt.Fprintf(signature, "%s\n\n\n%s\n\n\n\n\n\n\n\n\n%s%s", method, length, headers, resource)
	request.Header.Set("Authorization", "SharedKey stcaosetupsim:"+base64.StdEncoding.EncodeToString(signature.Sum(nil)))
	response, err := s.client.Do(request) // #nosec G704 -- transport rejects destinations outside the exact numeric-loopback Azurite endpoint.
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	content, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("Azurite %s returned HTTP %d", method, response.StatusCode)
	}
	return content, nil
}
