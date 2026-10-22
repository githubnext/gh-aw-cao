package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	for _, tt := range []struct {
		args, legacy []string
		input        string
		code         int
	}{
		{args: []string{"pages", "--json"}},
		{args: []string{"pages", "overview", "--json"}},
		{args: []string{"queries", "--json"}},
		{args: []string{"query-info", "campaign-inventory", "--json"}},
		{args: []string{"prompt", "campaign-runs", "--param", "campaign=dependabot"}},
		{args: []string{"query", "--database", database, "--collection", "runs", "--where", "conclusion=failure", "--limit", "3"}},
		{args: []string{"query", "--database", database, "--stdin"}, input: `{"name":"empty-runs","from":"runs","limit":3}`},
		{args: []string{"gh", "runs", "--database", database, "-R", "owner/repo", "-L", "3"}},
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
	t.Chdir(t.TempDir())
	t.Setenv("PATH", "")
	root, stdout, _ := testCommand(t, func(_ context.Context, args ...string) (string, string, error) {
		if args[0] == "aw" {
			return "", "gh-aw v0.92.0", nil
		}
		return "Acme-Org/ops.tools\n", "", nil
	}, nil)
	root.SetArgs([]string{"init"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	policy, err := readPolicy()
	if err != nil {
		t.Fatal(err)
	}
	// Complete frozen initializeCaoPolicy result and policy contract.
	const expected = `{"$schema":"https://raw.githubusercontent.com/githubnext/gh-cao/main/.github/workflows/shared/cao.schema.json","version":1,"gh-aw-version":"v0.92.0","control-plane":{"scope":{"allowed-owners":["Acme-Org"],"allowed-repositories":["Acme-Org/ops.tools"]},"marketplace":{"registries":[{"id":"official","name":"Official CAO catalog","repository":"githubnext/gh-cao","ref":"main","auth":{"type":"none"}},{"id":"agentics","name":"Agentics workflows","repository":"githubnext/agentics","path":"workflows","format":"workflows","ref":"main","auth":{"type":"none"}}]},"campaigns":{}}}`
	var want map[string]any
	decoder := json.NewDecoder(strings.NewReader(expected))
	decoder.UseNumber()
	if err := decoder.Decode(&want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(policy, want) {
		t.Fatalf("native initial policy = %v, want frozen policy %v", policy, want)
	}
	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"command": "init", "policy": policyPath, "gh-aw-version": "v0.92.0"}; !reflect.DeepEqual(result, want) {
		t.Fatalf("init result = %v, want %v", result, want)
	}
}
