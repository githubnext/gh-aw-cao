package cli

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// Exercise production command parsing and state transitions with an isolated
// GitHub variable store. No real organization settings or credentials are used.
func TestAdmissionOperatorJourney(t *testing.T) {
	nativeSetupTestDirectory(t)
	policy := nativeSetupTestPolicy()
	scope := nativeSetupMap(nativeSetupMap(policy["control-plane"])["scope"])
	scope["allowed-repositories"] = []string{"org/control", "org/project"}
	nativeSetupTestSave(t, policy)
	variables := map[string]map[string]string{
		"repos/org/control": {"UNRELATED_DEFAULT": "preserved"},
		"repos/org/project": {},
		"orgs/org":          {},
	}
	writes := 0
	gh := func(_ context.Context, args ...string) (string, string, error) {
		t.Helper()
		if len(args) < 4 || !slices.Equal(args[:3], []string{"api", "--hostname", "github.com"}) {
			t.Fatalf("unexpected command %v", args)
		}
		endpoint, _, _ := strings.Cut(strings.ReplaceAll(args[3], "{owner}/{repo}", "org/control"), "?")
		base, suffix, found := strings.Cut(endpoint, "/actions/")
		if !found {
			t.Fatalf("unexpected endpoint %q", endpoint)
		}
		inherited := suffix == "organization-variables"
		if inherited {
			base = "orgs/" + strings.Split(strings.TrimPrefix(base, "repos/"), "/")[0]
		}
		values := variables[base]
		if values == nil {
			t.Fatalf("out-of-scope target %q", base)
		}
		if slices.Contains(args, "--method") {
			writes++
			var name, value string
			for index, arg := range args {
				if arg == "--raw-field" && index+1 < len(args) {
					key, field, _ := strings.Cut(args[index+1], "=")
					if key == "name" {
						name = field
					}
					if key == "value" {
						value = field
					}
				}
			}
			if name == "" {
				_, name, _ = strings.Cut(suffix, "variables/")
			}
			if !slices.Contains(admissionVariables, name) || inherited {
				t.Fatalf("invalid write %v", args)
			}
			values[name] = value
			return "", "", nil
		}
		entries := []map[string]string{}
		for _, name := range admissionVariables {
			if value, exists := values[name]; exists {
				entries = append(entries, map[string]string{"name": name, "value": value})
			}
		}
		data, err := json.Marshal(entries)
		if err != nil {
			t.Fatal(err)
		}
		return string(data), "", nil
	}
	run := func(args ...string) string {
		t.Helper()
		root, output, _ := testCommand(t, gh, nil)
		root.SetArgs(append(args, "--json"))
		if err := root.ExecuteContext(t.Context()); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return output.String()
	}
	const endpoint = "https://cao.example/api/admission"
	t.Run("preview canary", func(t *testing.T) {
		run("setup", "admission", "--repo", "org/control", "--url", endpoint, "--dry-run")
		if writes != 0 {
			t.Fatal("preview changed settings")
		}
	})
	t.Run("configure canary", func(t *testing.T) {
		run("setup", "admission", "--repo", "org/control", "--url", endpoint)
		if writes != 3 || variables["repos/org/control"][admissionOutageVariable] != "block" {
			t.Fatal("canary setup failed")
		}
	})
	t.Run("preview fleet with configured server", func(t *testing.T) {
		out := run("setup", "admission", "--all-repos", "--dry-run")
		if writes != 3 || !strings.Contains(out, endpoint) {
			t.Fatal("configured default lost or preview mutated")
		}
	})
	t.Run("roll out fleet", func(t *testing.T) {
		run("setup", "admission", "--all-repos")
		if writes != 9 || variables["repos/org/project"][admissionURLVariable] != endpoint {
			t.Fatal("fleet did not inherit the configured server")
		}
		if variables["repos/org/control"]["UNRELATED_DEFAULT"] != "preserved" {
			t.Fatal("unrelated default changed")
		}
	})
	t.Run("verify operation settings", func(t *testing.T) {
		out := run("admission", "status", "--all-repos")
		var report struct {
			Results []admissionCLIReport `json:"results"`
		}
		if err := json.Unmarshal([]byte(out), &report); err != nil {
			t.Fatal(err)
		}
		if len(report.Results) != 2 {
			t.Fatal("fleet report incomplete")
		}
		for _, result := range report.Results {
			if !result.Enabled || result.Settings.URL != endpoint || result.Settings.OnOutage != "block" {
				t.Fatalf("not configured: %+v", result)
			}
		}
	})
	t.Run("disable canary and recover", func(t *testing.T) {
		before := writes
		run("admission", "disable", "--repo", "org/project", "--dry-run")
		if writes != before {
			t.Fatal("disable preview mutated")
		}
		run("admission", "disable", "--repo", "org/project")
		var report admissionCLIReport
		if err := json.Unmarshal([]byte(run("admission", "status", "--repo", "org/project")), &report); err != nil {
			t.Fatal(err)
		}
		if report.Enabled {
			t.Fatal("disabled override not respected")
		}
		run("setup", "admission", "--repo", "org/project")
		if variables["repos/org/project"][admissionURLVariable] != endpoint {
			t.Fatal("recovery did not reuse the control server")
		}
	})
}
