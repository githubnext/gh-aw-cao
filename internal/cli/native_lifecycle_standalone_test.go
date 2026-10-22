package cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testNativeStandaloneLifecycle(t *testing.T, binary string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake gh uses a POSIX shell")
	}
	working := t.TempDir()
	tools := t.TempDir()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(git, filepath.Join(tools, "git")); err != nil {
		t.Fatal(err)
	}
	initialize := exec.Command(git, "init", "--quiet", working)
	if output, err := initialize.CombinedOutput(); err != nil {
		t.Fatalf("initialize standalone checkout: %v\n%s", err, output)
	}
	for _, name := range append(append([]string{}, setupRuntimeFiles...), nativeRuntimeRequiredFiles...) {
		writeTestFile(t, filepath.Join(working, name), "installed runtime: "+name)
	}
	writeTestFile(t, filepath.Join(working, ".github", "aw", "packages", "demo.json"),
		`{"package":"githubnext/gh-cao/demo","source":"githubnext/gh-cao/demo@v1.0.0","resolvedCommit":"`+testCampaignSHA+`"}`)
	writeTestFile(t, filepath.Join(tools, "version"), "v0.92.4\n")
	writeTestFile(t, filepath.Join(tools, "archive"), campaignArchive(t, map[string]string{
		"catalog/demo/cao.json": testCampaignDeclaration,
	}))
	script := `#!/bin/sh
set -eu
printf '<%s>' "$@" >> "$CAO_TEST_TOOLS/calls"
printf '\n' >> "$CAO_TEST_TOOLS/calls"
case "$1 $2" in
  "auth status") ;;
  "aw version") IFS= read -r version < "$CAO_TEST_TOOLS/version"; printf '%s\n' "$version" >&2 ;;
  "aw add"|"aw update"|"aw upgrade"|"aw compile"|"workflow enable"|"workflow disable") ;;
  "extension install") printf '%s\n' "$5" > "$CAO_TEST_TOOLS/version" ;;
  "repo view")
    case "$*" in
      *nameWithOwner,visibility*) printf '%s\n' '{"nameWithOwner":"acme/control","visibility":"PUBLIC"}' ;;
      *) printf '%s\n' 'acme/control' ;;
    esac ;;
  "api --hostname")
    case "$4" in
      */tarball/*) /bin/cat "$CAO_TEST_TOOLS/archive" ;;
      */releases*) printf '%s\n' 'v1.0.0' ;;
      *) printf 'Unexpected API call\n' >&2; exit 91 ;;
    esac ;;
  "api repos/acme/control/pages")
    printf '%s\n' '{"build_type":"workflow","public":true,"html_url":"https://acme.github.io/control"}' ;;
  "api repos/acme/control/actions/variables?per_page=30"|"api repos/acme/control/actions/organization-variables?per_page=30") ;;
  *) printf 'Unexpected gh invocation\n' >&2; exit 92 ;;
esac
`
	executable := filepath.Join(tools, "gh")
	writeTestFile(t, executable, script)
	if err := os.Chmod(executable, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) map[string]any {
		t.Helper()
		command := exec.Command(binary, args...)
		command.Dir = working
		command.Env = append(os.Environ(), "PATH="+tools, "CAO_TEST_TOOLS="+tools,
			"CAO_RUNTIME_ROOT=/not-an-installed-runtime", "CI=1", "GH_HOST=github.com", "GITHUB_SERVER_URL=https://github.com")
		output, err := command.Output()
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				t.Fatalf("standalone %q: %v\n%s\n%s", args, err, output, exit.Stderr)
			}
			t.Fatalf("standalone %q: %v", args, err)
		}
		var result map[string]any
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("standalone %q did not produce JSON: %v\n%s", args, err, output)
		}
		return result
	}
	if got := run("init"); got["command"] != "init" {
		t.Fatalf("unexpected init result: %#v", got)
	}
	if got := run("setup", "--json"); got["profile"] != "workflow-token" || got["nonInteractive"] != true {
		t.Fatalf("unexpected setup result: %#v", got)
	}
	for _, profile := range []string{"token", "enterprise-app", "github-app", "hosted-cli"} {
		args := []string{"setup", "auth", profile, "--repo", "acme/control", "--dry-run"}
		if profile == "enterprise-app" {
			args = append(args, "--read-client-id", "Iv1.read", "--write-client-id", "Iv1.write")
		}
		run(args...)
	}
	writeTestFile(t, filepath.Join(working, ".github", "workflows", "daily-repo-status.md"), standaloneFixture)
	writeTestFile(t, filepath.Join(working, ".github", "workflows", "daily-repo-status.lock.yml"), "name: Daily Repo Status\n")
	if got := run("add", "daily-repo-status", "--force"); got["workflow"] != "daily-repo-status" {
		t.Fatalf("standalone workflow was dispatched as a campaign: %#v", got)
	}
	if got := run("add", "githubnext/gh-cao/demo@v1.0.0", "--force"); got["campaign"] != "demo" {
		t.Fatalf("unexpected campaign installation: %#v", got)
	}
	run("campaigns", "mode", "preview", "demo")
	run("campaigns", "enable", "demo")
	run("campaigns", "disable", "demo")
	if got := run("update", "--campaign", "demo", "--force"); got["command"] != "update" {
		t.Fatalf("unexpected update result: %#v", got)
	}
	if got := run("upgrade-gh-aw", "v0.93.0"); got["command"] != "upgrade-gh-aw" {
		t.Fatalf("unexpected upgrade result: %#v", got)
	}
	content, err := os.ReadFile(filepath.Join(working, policyPath))
	if err != nil {
		t.Fatal(err)
	}
	var policy map[string]any
	if err := json.Unmarshal(content, &policy); err != nil {
		t.Fatal(err)
	}
	control := policy["control-plane"].(map[string]any)
	scope := control["scope"].(map[string]any)
	if policy["gh-aw-version"] != "v0.93.0" || len(scope["allowed-repositories"].([]any)) != 1 ||
		scope["allowed-repositories"].([]any)[0] != "acme/control" ||
		control["campaigns"].(map[string]any)["demo"].(map[string]any)["mode"] != "review" {
		t.Fatalf("lifecycle changed authority or failed to persist policy: %s", content)
	}
	registration := control["workflows"].(map[string]any)["daily-repo-status"].(map[string]any)
	if registration["mode"] != "review" || registration["max-mode"] != "review" || registration["max-repositories"] != float64(1) {
		t.Fatalf("standalone workflow was not review bounded: %s", content)
	}
	calls, err := os.ReadFile(filepath.Join(tools, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"<aw><add><githubnext/gh-cao/.github/workflows/daily-repo-status.md><--dir><.github/workflows><--force>",
		"<aw><compile><.github/workflows/daily-repo-status.md><--strict><--schedule-seed><githubnext/gh-cao><--no-check-update>",
		"<aw><add><githubnext/gh-cao/demo@v1.0.0><--force>",
		"<workflow><enable><demo.lock.yml>",
		"<workflow><enable><demo-second.lock.yml>",
		"<workflow><enable><demo-first.lock.yml>",
		"<workflow><disable><demo.lock.yml>",
		"<aw><update><https://github.com/githubnext/gh-cao/demo><--force>",
		"<extension><install><github/gh-aw><--pin><v0.93.0><--force>",
		"<aw><upgrade>",
	} {
		if !strings.Contains(string(calls), expected+"\n") {
			t.Fatalf("installed binary omitted %s:\n%s", expected, calls)
		}
	}
	for _, forbidden := range []string{"<workflow><run>", "<secret>", "<variable>", "<cao>", "<node>"} {
		if strings.Contains(string(calls), forbidden) {
			t.Fatalf("lifecycle performed an unrequested side effect %s:\n%s", forbidden, calls)
		}
	}
}
