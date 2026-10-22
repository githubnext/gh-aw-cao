package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func nodeRuntime(t *testing.T) (string, string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js 24+ is required for shared-runtime parity checks")
	}
	output, err := exec.Command(node, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	version := strings.TrimSpace(strings.TrimPrefix(string(output), "v"))
	major, _, _ := strings.Cut(version, ".")
	number, err := strconv.Atoi(major)
	if err != nil || number < 24 {
		t.Skip("Node.js 24+ is required for shared-runtime parity checks")
	}
	repository, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return node, repository
}

func TestNativeOperatorOutputParity(t *testing.T) {
	node, repository := nodeRuntime(t)
	t.Setenv("CAO_RUNTIME_ROOT", repository)
	t.Setenv("CAO_DEBUG", "")
	t.Setenv("NODE_NO_WARNINGS", "1")
	directory := t.TempDir()
	database := filepath.Join(directory, "snapshot.sqlite")
	policy := filepath.Join(directory, "cao.json")
	writeTestFile(t, policy, `{"version":1,"control-plane":{"scope":{"allowed-repositories":["owner/repo"]}}}`)
	for _, tt := range []struct {
		args, legacy []string
		input        string
		code         int
	}{
		{args: []string{"queries", "--json"}},
		{args: []string{"query-info", "campaign-inventory", "--json"}},
		{args: []string{"prompt", "campaign-runs", "--param", "campaign=dependabot"}},
		{args: []string{"query", "--database", database, "--collection", "runs", "--where", "conclusion=failure", "--limit", "3"}},
		{args: []string{"query", "--database", database, "--stdin"}, input: `{"name":"empty-runs","from":"runs","limit":3}`},
		{args: []string{"gh", "runs", "--database", database, "-R", "owner/repo", "-L", "3"}},
		{args: []string{"setup", "auth", "token", "--repo", "owner/repo", "--policy", policy, "--write-repository", "owner/target", "--dry-run"},
			legacy: []string{"setup-auth", "token", "--repo", "owner/repo", "--policy", policy, "--write-repository", "owner/target", "--dry-run"}},
		{args: []string{"setup", "auth", "enterprise-app", "--repo", "owner/repo", "--read-client-id", "read", "--write-client-id", "write", "--policy", policy, "--write-repository", "owner/target", "--dry-run"},
			legacy: []string{"setup-auth", "enterprise-app", "--repo", "owner/repo", "--read-client-id", "read", "--write-client-id", "write", "--policy", policy, "--write-repository", "owner/target", "--dry-run"}},
		{args: []string{"setup", "auth", "token", "--repo", "owner/repo", "--policy", policy, "--expires-in", "367", "--dry-run"},
			legacy: []string{"setup-auth", "token", "--repo", "owner/repo", "--policy", policy, "--expires-in", "367", "--dry-run"}, code: 1},
		{args: []string{"download", "--url", "file:///not-an-http-snapshot"}, code: 1},
		{args: []string{"query-info", "not-a-real-query", "--json"}, code: 1},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			legacy := tt.legacy
			if legacy == nil {
				legacy = tt.args
			}
			baseline := exec.CommandContext(ctx, node, append([]string{filepath.Join(repository, "activity", "cao.mjs")}, legacy...)...)
			baseline.Stdin = strings.NewReader(tt.input)
			var wantOut, wantErr bytes.Buffer
			baseline.Stdout, baseline.Stderr = &wantOut, &wantErr
			baselineErr := baseline.Run()
			baselineCode := 0
			if baselineErr != nil {
				var exit *exec.ExitError
				if !errors.As(baselineErr, &exit) {
					t.Fatal(baselineErr)
				}
				baselineCode = exit.ExitCode()
			}
			if baselineCode != tt.code {
				t.Fatalf("baseline failed with %d (want %d): %s", baselineCode, tt.code, wantErr.String())
			}
			root := NewRootCommand("test")
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			root.SetIn(strings.NewReader(tt.input))
			root.SetArgs(tt.args)
			err := root.ExecuteContext(ctx)
			code := 0
			if err != nil {
				code = 1
				var exit *ExitError
				if errors.As(err, &exit) {
					code = exit.Code
				} else {
					stderr.WriteString("Error: " + err.Error() + "\n")
				}
			}
			equalOutput := bytes.Equal(stdout.Bytes(), wantOut.Bytes())
			if !equalOutput {
				var gotJSON, wantJSON any
				if json.Unmarshal(stdout.Bytes(), &gotJSON) == nil && json.Unmarshal(wantOut.Bytes(), &wantJSON) == nil {
					equalOutput = reflect.DeepEqual(gotJSON, wantJSON)
				}
			}
			if code != baselineCode || !equalOutput || !bytes.Equal(stderr.Bytes(), wantErr.Bytes()) {
				t.Fatalf("runtime parity mismatch:\nstatus=%d (want %d)\nstdout=%s\nwant stdout=%s\nstderr=%s\nwant stderr=%s",
					code, baselineCode, &stdout, &wantOut, &stderr, &wantErr)
			}
		})
	}
}

func TestNativePolicyMatchesProductionContract(t *testing.T) {
	node, repository := nodeRuntime(t)
	t.Chdir(t.TempDir())
	legacyPolicy := filepath.Join(t.TempDir(), "cao.json")
	program := `
const { initializeCaoPolicy } = await import(process.argv[1]);
const result = await initializeCaoPolicy({
  policyPath: process.argv[2],
  execute(_command, args) {
    return args[0] === "aw"
      ? {status:0, stdout:"", stderr:"gh-aw v0.92.0"}
      : {status:0, stdout:"Acme-Org/ops.tools\n", stderr:""};
  }
});
process.stdout.write(JSON.stringify(result));
`
	if output, err := exec.Command(node, "--input-type=module", "-e", program,
		filepath.Join(repository, "activity", "cli", "policy.mjs"), legacyPolicy).CombinedOutput(); err != nil {
		t.Fatalf("production init: %v: %s", err, output)
	}
	root, _, _ := testCommand(t, func(_ context.Context, args ...string) (string, string, error) {
		if args[0] == "aw" {
			return "", "gh-aw v0.92.0", nil
		}
		return "Acme-Org/ops.tools\n", "", nil
	}, nil)
	root.SetArgs([]string{"init"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	read := func(path string) any {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var value any
		if err := json.Unmarshal(content, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got, want := read(policyPath), read(legacyPolicy); !reflect.DeepEqual(got, want) {
		t.Fatalf("native initial policy = %v, want production policy %v", got, want)
	}
}
