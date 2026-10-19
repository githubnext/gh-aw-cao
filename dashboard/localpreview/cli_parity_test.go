package localpreview_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/internal/cli"
)

func cliDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp(".", ".native-cli-parity-")
	if err != nil {
		t.Fatal(err)
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		t.Fatal(err)
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(directory); err != nil {
			t.Error(err)
		}
	})
	t.Setenv("TMPDIR", directory)
	t.Setenv("TMP", directory)
	t.Setenv("TEMP", directory)
	return directory
}

func executeDashboard(t *testing.T, arguments ...string) (string, error) {
	t.Helper()
	command := cli.NewRootCommand("native-parity-test")
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs(append([]string{"dashboard", "serve"}, arguments...))
	err := command.ExecuteContext(t.Context())
	return output.String(), err
}

func writeCLIFile(t *testing.T, name, contents string, executable bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if executable {
		if err := os.Chmod(name, 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

func assertHostedCleanup(t *testing.T, workspace string) {
	t.Helper()
	entries, err := os.ReadDir(workspace)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "cao-dashboard-hosted-") {
			t.Fatalf("hosted launcher leaked its private build directory %q", entry.Name())
		}
	}
}

func TestNativeCLIHelpAndHostedFlagValidation(t *testing.T) {
	workspace := cliDirectory(t)
	t.Setenv("PATH", workspace)
	output, err := executeDashboard(t, "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{
		"--canvas", "--data-backend", "--replace-existing", "--operational-store",
		"--command-concurrency", "--acknowledge-command-recovery",
	} {
		if !strings.Contains(output, flag) {
			t.Errorf("native help omitted %s", flag)
		}
	}
	for _, test := range []struct {
		flags   []string
		message string
	}{
		{[]string{"--operational-store"}, "flag needs an argument"},
		{[]string{"--data-backend"}, "flag needs an argument"},
		{[]string{"--data-backend", "redis"}, "--data-backend must be"},
		{[]string{"--operational-store", "sqlite"}, "--operational-store must be"},
		{[]string{"--operational-store", "redis", "--canvas"}, "--canvas cannot be used"},
		{[]string{"--operational-store", "redis", "--admin"}, "--admin cannot be used"},
		{[]string{"--operational-store", "redis", "--replace-existing"}, "--replace-existing cannot be used"},
		{[]string{"--operational-store", "memory", "--trace-file", "trace.jsonl"}, "--trace-file cannot be used"},
		{[]string{"--operational-store", "memory", "--cao-url", "https://example.test/"}, "--cao-url cannot be used"},
		{[]string{"--operational-store", "memory", "--command-concurrency", "1"}, "--command-concurrency cannot be used"},
		{[]string{"--operational-store", "memory", "--acknowledge-command-recovery"}, "--acknowledge-command-recovery cannot be used"},
		{[]string{"--operational-store", "memory", "--cert", "certificate.pem"}, "--cert and --key must be provided together"},
		{[]string{"--operational-store", "memory", "--key", "private.pem"}, "--cert and --key must be provided together"},
		{[]string{"--data-backend", "postgres", "--canvas"}, "--canvas cannot be used"},
		{[]string{"--data-backend", "postgres", "--repo", "owner/repo"}, "--repo cannot be used"},
		{[]string{"--command-concurrency", "1.5"}, "invalid argument"},
		{[]string{"--command-concurrency", "NaN"}, "invalid argument"},
	} {
		t.Run(strings.Join(test.flags, " "), func(t *testing.T) {
			_, err := executeDashboard(t, append([]string{"--workspace", workspace}, test.flags...)...)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected native flag validation %q, got %v", test.message, err)
			}
		})
	}
}

func TestNativeHostedCLIArgumentsAndPolicyImmutability(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("hosted executable fixture uses a POSIX shell")
	}
	workspace := cliDirectory(t)
	executable := filepath.Join(workspace, "hosted-fixture")
	writeCLIFile(t, executable, "#!/bin/sh\n"+
		"printf 'cwd=%s\\npolicy=%s\\npostgres=%s\\n' \"$(pwd -P)\" \"$CAO_POLICY_PATH\" \"$CAO_POSTGRES_URL\"\n"+
		"printf 'argument=%s\\n' \"$@\"\n", true)
	t.Setenv("CAO_DASHBOARD_EXECUTABLE", executable)
	t.Setenv("CAO_POLICY_PATH", "ignored.json")
	t.Setenv("CAO_POSTGRES_URL", "postgres://fixture")
	for _, store := range []string{"postgres", "redis", "memory"} {
		t.Run(store, func(t *testing.T) {
			policy := filepath.Join(workspace, store+".json")
			document := `{"fixture":"` + store + `"}`
			writeCLIFile(t, policy, document, false)
			output, err := executeDashboard(t,
				"--workspace", workspace, "--catalog", workspace,
				"--data-backend", "postgres", "--operational-store", store,
				"--policy", policy, "--site", "built", "--host", "::1", "--port", "8443",
				"--cert", "cert.pem", "--key", "key.pem")
			if err != nil {
				t.Fatal(err)
			}
			expected := []string{
				"cwd=" + workspace, "policy=" + policy, "postgres=postgres://fixture",
				"argument=serve-hosted", "argument=--operational-store", "argument=" + store,
				"argument=--listen", "argument=[::1]:8443",
				"argument=--site", "argument=" + filepath.Join(workspace, "built"),
				"argument=--cert", "argument=" + filepath.Join(workspace, "cert.pem"),
				"argument=--key", "argument=" + filepath.Join(workspace, "key.pem"),
			}
			if actual := strings.Split(strings.TrimSpace(output), "\n"); !slices.Equal(actual, expected) {
				t.Fatalf("unexpected native hosted invocation:\n%s", output)
			}
			content, err := os.ReadFile(policy)
			if err != nil || string(content) != document {
				t.Fatalf("reviewed policy changed: %s, %v", content, err)
			}
			if os.Getenv("CAO_POLICY_PATH") != "ignored.json" || os.Getenv("CAO_POSTGRES_URL") != "postgres://fixture" {
				t.Fatal("hosted launcher modified its parent's policy or database environment")
			}
			assertHostedCleanup(t, workspace)
		})
	}
}

func TestNativeHostedCLIPolicyEnvironmentPrecedence(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("hosted executable fixture uses a POSIX shell")
	}
	workspace := cliDirectory(t)
	executable := filepath.Join(workspace, "policy-fixture")
	writeCLIFile(t, executable, "#!/bin/sh\nprintf '%s' \"$CAO_POLICY_PATH\"\n", true)
	t.Setenv("CAO_DASHBOARD_EXECUTABLE", executable)
	for _, test := range []struct {
		name, primary, secondary, selected string
	}{
		{"primary", "primary.json", "secondary.json", "primary.json"},
		{"secondary", "", "secondary.json", "secondary.json"},
		{"blank-primary", " ", "secondary.json", "secondary.json"},
		{"default", "", "", filepath.Join(".github", "workflows", "cao.json")},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("CAO_POLICY_PATH", test.primary)
			t.Setenv("CAO_MARKETPLACE_POLICY_PATH", test.secondary)
			output, err := executeDashboard(t,
				"--workspace", workspace, "--catalog", workspace, "--operational-store", "memory")
			if err != nil {
				t.Fatal(err)
			}
			if output != filepath.Join(workspace, test.selected) {
				t.Fatalf("unexpected selected policy %q", output)
			}
			if os.Getenv("CAO_POLICY_PATH") != test.primary || os.Getenv("CAO_MARKETPLACE_POLICY_PATH") != test.secondary {
				t.Fatal("policy resolution modified its source environment")
			}
			assertHostedCleanup(t, workspace)
		})
	}
}

func TestNativeHostedCLIFailedBuildRemovesPartialBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Go executable fixture uses a POSIX shell")
	}
	workspace := cliDirectory(t)
	writeCLIFile(t, filepath.Join(workspace, "server", "go.mod"), "module fixture\n", false)
	buildRecord := filepath.Join(workspace, "built-executable")
	writeCLIFile(t, filepath.Join(workspace, "bin", "go"), "#!/bin/sh\n"+
		"while [ \"$#\" -gt 0 ]; do\n"+
		"  if [ \"$1\" = '-o' ]; then\n"+
		"    shift\n"+
		"    printf 'partial native build' > \"$1\"\n"+
		"    printf '%s' \"$1\" > \"$CAO_TEST_BUILD_RECORD\"\n"+
		"    exit 23\n"+
		"  fi\n"+
		"  shift\n"+
		"done\n"+
		"exit 24\n", true)
	t.Setenv("CAO_DASHBOARD_EXECUTABLE", "")
	t.Setenv("CAO_TEST_BUILD_RECORD", buildRecord)
	t.Setenv("PATH", filepath.Join(workspace, "bin")+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := executeDashboard(t, "--workspace", workspace, "--catalog", workspace, "--operational-store", "memory")
	if err == nil || !strings.Contains(err.Error(), "build hosted Go server") {
		t.Fatalf("build failure was not reported: %v", err)
	}
	content, err := os.ReadFile(buildRecord)
	if err != nil {
		t.Fatal(err)
	}
	executable := string(content)
	if !strings.HasPrefix(executable, workspace+string(filepath.Separator)) {
		t.Fatal("native build escaped its selected private directory")
	}
	if _, err := os.Stat(executable); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial binary was not removed: %v", err)
	}
	assertHostedCleanup(t, workspace)
}
