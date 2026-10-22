package cli

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStatusCommandInventory(t *testing.T) {
	root, _, _ := testCommand(t, nil, nil)
	status, _, err := root.Find([]string{"status"})
	if err != nil || status.Name() != "status" {
		t.Fatalf("status command not found: %v", err)
	}
	var names []string
	for _, command := range status.Commands() {
		names = append(names, command.Name())
	}
	if !reflect.DeepEqual(names, []string{"pages"}) {
		t.Fatalf("status command inventory = %v, want [pages]", names)
	}
}

func TestTopLevelPagesIsRetired(t *testing.T) {
	for _, args := range [][]string{
		{"pages"}, {"pages", "--json"}, {"pages", "overview", "--json"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			root, stdout, stderr := testCommand(t, nil, nil)
			root.SetArgs(args)
			if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "unknown") {
				t.Fatalf("expected retired pages command to fail, got %v", err)
			}
			if stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout, stderr)
			}
		})
	}
	root, stdout, _ := testCommand(t, nil, nil)
	root.SetArgs([]string{"pages", "--help"})
	if err := root.Execute(); err != nil || strings.Contains(stdout.String(), "gh cao pages") {
		t.Fatalf("retired pages command has help: %v\n%s", err, stdout)
	}
}

func TestStatusPagesDiscovery(t *testing.T) {
	for _, tt := range []struct {
		args    []string
		want    string
		notWant string
	}{
		{[]string{"--help"}, "  status ", "  pages "},
		{[]string{"status", "--help"}, "  pages ", ""},
		{[]string{"status", "pages", "--help"}, "gh cao status pages [PAGE_ID]", ""},
		{[]string{"__complete", ""}, "status\t", "pages\t"},
		{[]string{"__complete", "status", ""}, "pages\t", ""},
		{[]string{"__complete", "status", "pages", "--"}, "--dashboard\t", ""},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			root, stdout, _ := testCommand(t, nil, nil)
			root.SetArgs(tt.args)
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			if output := stdout.String(); !strings.Contains(output, tt.want) ||
				(tt.notWant != "" && strings.Contains(output, tt.notWant)) {
				t.Fatalf("unexpected discovery output:\n%s", output)
			}
		})
	}
}

func TestNativeStatusPagesCustomDashboardOffline(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "custom dashboard.json")
	writeTestFile(t, source, `{
		"language-version":"0.1.0",
		"dashboard":{
			"navigation":[{"label":"Custom","pages":["custom"]}],
			"pages":[{"id":"custom","title":"Custom evidence","description":"Inspect custom evidence."}]
		}
	}`)
	t.Chdir(t.TempDir())
	t.Setenv("PATH", "")
	t.Setenv("CAO_RUNTIME_ROOT", filepath.Join(directory, "missing-runtime"))
	for _, tt := range []struct {
		tail []string
		key  string
	}{
		{nil, ""},
		{[]string{"--json"}, "pages"},
		{[]string{"custom", "--json"}, "page"},
	} {
		t.Run(strings.Join(tt.tail, " "), func(t *testing.T) {
			root := NewRootCommand("test")
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			root.SetArgs(append([]string{"status", "pages", "--dashboard", source}, tt.tail...))
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			if stderr.Len() != 0 {
				t.Fatalf("unexpected stderr: %s", &stderr)
			}
			if tt.key == "" {
				if stdout.String() != "Dashboard pages (1):\n  custom  Custom evidence\n    Inspect custom evidence.\n" {
					t.Fatalf("unexpected text output: %s", &stdout)
				}
				return
			}
			var result map[string]any
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result["command"] != "pages" || result[tt.key] == nil || len(result) != 2 {
				t.Fatalf("page output envelope changed: %s", &stdout)
			}
			page := result["page"]
			if tt.key == "pages" {
				pages := nativeArray(result["pages"])
				if len(pages) != 1 {
					t.Fatalf("unexpected pages: %s", &stdout)
				}
				page = pages[0]
			}
			if nativeObject(page)["id"] != "custom" {
				t.Fatalf("did not use custom dashboard: %s", &stdout)
			}
		})
	}
}

func TestNativeStatusPagesDashboardErrors(t *testing.T) {
	directory := t.TempDir()
	invalid := filepath.Join(directory, "invalid.json")
	writeTestFile(t, invalid, `{}`)
	for _, source := range []string{invalid, filepath.Join(directory, "missing.json")} {
		t.Run(filepath.Base(source), func(t *testing.T) {
			root := NewRootCommand("test")
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			root.SetArgs([]string{"status", "pages", "--dashboard", source, "--json"})
			if err := root.Execute(); err == nil {
				t.Fatal("expected dashboard read/validation error")
			}
			if stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("errors should be rendered once by main: stdout=%q stderr=%q", &stdout, &stderr)
			}
		})
	}
}

func TestNativeStatusPagesOutputParity(t *testing.T) {
	node, repository := nodeRuntime(t)
	program := `
const { describeAgentPages } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(await describeAgentPages({ pageId: process.argv[2] || undefined, json: true })));
`
	for _, pageID := range []string{"", "overview"} {
		t.Run(pageID, func(t *testing.T) {
			expected, err := exec.Command(node, "--input-type=module", "-e", program,
				filepath.Join(repository, "activity", "agent-catalog.mjs"), pageID).Output()
			if err != nil {
				t.Fatal(err)
			}
			root := NewRootCommand("test")
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			args := []string{"status", "pages", "--json"}
			if pageID != "" {
				args = append(args, pageID)
			}
			root.SetArgs(args)
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(expected, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) || stderr.Len() != 0 {
				t.Fatalf("native page output differs from shared catalog: stdout=%s stderr=%s", &stdout, &stderr)
			}
		})
	}
}

func TestNativeStatusPagesUnknownPage(t *testing.T) {
	root := NewRootCommand("test")
	var stdout, stderr bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stderr)
	root.SetArgs([]string{"status", "pages", "not-a-page", "--json"})
	if err := root.Execute(); err == nil || err.Error() != "Unknown dashboard page: not-a-page" {
		t.Fatalf("unknown page error changed: %v", err)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("errors should be rendered once by main: stdout=%q stderr=%q", &stdout, &stderr)
	}
}
