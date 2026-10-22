package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeCampaignAddCanonicalSources(t *testing.T) {
	for _, source := range []string{"demo", "demo@feature/config", "githubnext/gh-cao/demo@feature/config"} {
		t.Run(source, func(t *testing.T) {
			nativeManagementDirectory(t)
			t.Setenv("PATH", "")
			archive := campaignArchive(t, map[string]string{"catalog/demo/cao.json": testCampaignDeclaration})
			var calls [][]string
			cmd, _, _ := testCommand(t, campaignGH(t, archive, &calls), nil)
			cmd.SetArgs([]string{"campaigns", "add", source, "--engine", "copilot", "--unknown-future-option"})
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			spec := source
			if strings.HasPrefix(spec, "demo") {
				spec = catalogRepository + "/" + spec
			}
			if want := []string{"aw", "add", spec, "--engine", "copilot", "--unknown-future-option"}; !reflect.DeepEqual(calls[0], want) {
				t.Fatalf("install arguments = %q, want %q", calls[0], want)
			}
		})
	}
}

func TestNativeCampaignAddInvalidSourceDoesNotExecute(t *testing.T) {
	for _, args := range [][]string{
		{}, {""}, {"--force"}, {"demo@"}, {"./missing"}, {"missing.md"}, {catalogRepository},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			nativeManagementDirectory(t)
			cmd, stdout, _ := testCommand(t, nil, nil)
			cmd.SetArgs(append([]string{"campaigns", "add"}, args...))
			if err := cmd.Execute(); err == nil {
				t.Fatal("invalid campaign source accepted")
			}
			if stdout.Len() != 0 {
				t.Fatal("invalid campaign source reported success")
			}
		})
	}
}

func TestNativeSetupAuthenticationFrozenCommandContracts(t *testing.T) {
	nativeManagementDirectory(t)
	t.Setenv("PATH", "")
	writeTestFile(t, policyPath, `{"version":1,"control-plane":{"scope":{"allowed-repositories":["owner/repo"]}}}`)
	for _, test := range []struct {
		method, expected string
		extra            []string
	}{
		{"token", `{"command":"setup-auth","profile":"fine-grained-token","repo":"owner/repo","secrets":[{"owner":"owner","role":"read","secret":"GH_AW_GITHUB_READ_PAT_OWNER"},{"owner":"owner","role":"write","secret":"GH_AW_GITHUB_WRITE_PAT_OWNER"}],"repositories":{"read":{"owner/repo":"GH_AW_GITHUB_READ_PAT_OWNER"},"write":{"owner/target":"GH_AW_GITHUB_WRITE_PAT_OWNER"}}}`, nil},
		{"enterprise-app", `{"command":"setup-auth","profile":"enterprise-app","repo":"owner/repo","repositories":{"read":["owner/repo"],"write":["owner/target"]},"credentials":[{"role":"read","clientId":"read","variable":"GH_AW_GITHUB_READ_APP_ID","secret":"GH_AW_GITHUB_READ_APP_PRIVATE_KEY"},{"role":"write","clientId":"write","variable":"GH_AW_GITHUB_WRITE_APP_ID","secret":"GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY"}]}`, []string{"--read-client-id", "read", "--write-client-id", "write"}},
	} {
		t.Run(test.method, func(t *testing.T) {
			gh := func(context.Context, ...string) (string, string, error) {
				t.Fatal("dry-run authentication invoked GitHub")
				return "", "", nil
			}
			cmd, stdout, _ := testCommand(t, gh, nativeOperator(gh))
			args := []string{"setup", "auth", test.method, "--repo", "owner/repo", "--policy", policyPath, "--write-repository", "owner/target", "--dry-run"}
			cmd.SetArgs(append(args, test.extra...))
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(test.expected), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("native authentication = %s, want frozen contract %s", stdout, test.expected)
			}
		})
	}
	cmd, stdout, _ := testCommand(t, nil, nativeOperator(nil))
	cmd.SetArgs([]string{"setup", "auth", "token", "--repo", "owner/repo", "--expires-in", "367", "--dry-run"})
	if err := cmd.Execute(); err == nil || err.Error() != "--expires-in must be an integer from 1 through 366" || stdout.Len() != 0 {
		t.Fatalf("invalid expiration = %v, output %s", err, stdout)
	}
}

func TestNativeSetupCustomPolicyValidatesOperationsBeforeCredentials(t *testing.T) {
	nativeManagementDirectory(t)
	filename := filepath.Join("config", "policy.json")
	writeTestFile(t, filename, `{"version":1,"control-plane":{"operations":[]}}`)
	before, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"token", "enterprise-app", "github-app"} {
		t.Run(method, func(t *testing.T) {
			gh := func(context.Context, ...string) (string, string, error) {
				t.Fatal("invalid policy invoked GitHub")
				return "", "", nil
			}
			cmd, stdout, _ := testCommand(t, gh, nativeOperator(gh))
			cmd.SetArgs([]string{"setup", "auth", method, "--repo", "owner/repo", "--policy", filename, "--dry-run"})
			if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "control-plane.operations must be an object") || stdout.Len() != 0 {
				t.Fatalf("malformed operations accepted: %v, output %s", err, stdout)
			}
		})
	}
	after, err := os.ReadFile(filename)
	if err != nil || string(before) != string(after) {
		t.Fatal("authentication validation changed operator policy")
	}
}
