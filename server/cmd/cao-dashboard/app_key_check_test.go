package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/githubapp"
)

func TestAppKeyCheckCommandOfflineRollover(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	content := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	path := filepath.Join(t.TempDir(), "key.pem")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	// These must not select credentials, initialize telemetry, or cause calls.
	t.Setenv("CAO_HOSTED_CLI_PRIVATE_KEY", "sensitive-env-sentinel")
	t.Setenv("CAO_HOSTED_CLI_GITHUB_API_URL", "https://invalid.invalid")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://invalid.invalid")
	execute := func(args ...string) (githubapp.KeyCheck, string, error) {
		t.Helper()
		cmd := newRootCommand()
		var output bytes.Buffer
		cmd.SetOut(&output)
		cmd.SetErr(&output)
		cmd.SetArgs(append([]string{"app-key-check"}, args...))
		err := cmd.Execute()
		var result githubapp.KeyCheck
		if err == nil {
			if decodeErr := json.Unmarshal(output.Bytes(), &result); decodeErr != nil {
				t.Fatal(decodeErr)
			}
		}
		return result, output.String(), err
	}
	result, output, err := execute("--key-file", path)
	if err != nil || len(result.PublicKeySHA256) != 64 || result.ExpectedKeyChecked || result.RotationKeyChecked {
		t.Fatalf("offline check: %+v, %v", result, err)
	}
	if strings.Contains(output, "PRIVATE") || strings.Contains(output, "sentinel") || strings.Contains(output, path) {
		t.Fatal("report must contain only public metadata")
	}
	pinned, _, err := execute("--key-file", path, "--expected-public-key-sha256", result.PublicKeySHA256,
		"--previous-public-key-sha256", strings.Repeat("0", 64))
	if err != nil || !pinned.ExpectedKeyChecked || !pinned.RotationKeyChecked {
		t.Fatalf("pinned rollover check: %+v, %v", pinned, err)
	}
	malformedPath := filepath.Join(t.TempDir(), "malformed.pem")
	if err := os.WriteFile(malformedPath, append([]byte("-----BEGIN RSA PRIVATE KEY-----\ninvalid!base64\n-----END RSA PRIVATE KEY-----\n"), content...), 0600); err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string][]string{
		"no implicit env key": {},
		"same key rollover":   {"--key-file", path, "--previous-public-key-sha256", result.PublicKeySHA256},
		"mismatch":            {"--key-file", path, "--expected-public-key-sha256", strings.Repeat("0", 64)},
		"empty pin":           {"--key-file", path, "--expected-public-key-sha256="},
		"empty previous":      {"--key-file", path, "--previous-public-key-sha256="},
		"missing file":        {"--key-file", filepath.Join(t.TempDir(), "sensitive-missing-key.pem")},
		"directory":           {"--key-file", t.TempDir()},
		"malformed prefix":    {"--key-file", malformedPath},
	} {
		t.Run(name, func(t *testing.T) {
			_, output, err := execute(args...)
			if err == nil || output != "" {
				t.Fatal("refusal must produce an error without a success report")
			}
			if strings.Contains(err.Error(), "sensitive") {
				t.Fatal("file error exposed the input")
			}
		})
	}
}

func TestAppKeyCheckRejectsOversizedOrEmptyFile(t *testing.T) {
	for _, size := range []int{0, githubapp.MaxPrivateKeyBytes + 1} {
		path := filepath.Join(t.TempDir(), "key.pem")
		if err := os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readAppKeyCheckFile(path); err == nil {
			t.Fatal("file bounds must fail closed")
		}
	}
}

func TestAppKeyCheckHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	cmd := newRootCommand()
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"app-key-check", "--key-file", "must-not-be-read"})
	if err := cmd.ExecuteContext(ctx); !errors.Is(err, context.Canceled) || output.Len() != 0 {
		t.Fatalf("canceled check must not read or emit a report: %v", err)
	}
}
