package localpreview

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanvasPreparationUsesFreshOrUnavailableCompilerEvidence(t *testing.T) {
	for _, version := range []string{"v0.91.6", ""} {
		t.Run("compiler-"+version, func(t *testing.T) {
			root := testDirectory(t)
			data := fixture(t, root)
			write(t, data, "inventory-sources.json", `{"workflows":{"metadata":{"as-of":"2026-10-01T00:00:00Z"},"rows":[{
				"organization":"octo","repository":"repo","workflow":"demo.md",
				"gh-aw-version":"v0.91.5","gh-aw-current-version":"v0.89.21","gh-aw-update-state":"up-to-date"
			}]}}`)
			executable := fakeGH(t, root, trustedArtifact, trustedRun)
			if version != "" {
				write(t, root, "compiler-response.json", string(compilerFileResponse(t, ".github/workflows/demo.lock.yml", version)))
				script := string(read(t, executable))
				script = strings.Replace(script, "  'run download')", "  'api repos/octo/repo/contents/.github/workflows/demo.lock.yml') cat compiler-response.json ;;\n  'run download')", 1)
				if err := os.WriteFile(executable, []byte(script), 0o700); err != nil { // #nosec G306 -- Private, trusted executable fixture.
					t.Fatal(err)
				}
			}
			w, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable, Canvas: true})
			if err != nil {
				t.Fatal(err)
			}
			defer closeWorkspace(t, w)
			sources, _, err := readObject(filepath.Join(w.SourceDirectory, "inventory-sources.json"))
			if err != nil {
				t.Fatal(err)
			}
			row := obj(list(obj(sources["workflows"])["rows"])[0])
			installed, state := version, "update-available"
			if version == "" {
				installed, state = "v0.91.5", "unknown"
			}
			if row["gh-aw-version"] != installed || row["gh-aw-current-version"] != "v0.92.0" || row["gh-aw-update-state"] != state {
				t.Fatalf("fresh/unavailable compiler evidence was not preserved: %#v", row)
			}
			calls := string(read(t, filepath.Join(root, "gh-calls")))
			if strings.Count(calls, "api repos/octo/repo/contents/.github/workflows/demo.lock.yml --include") != 1 {
				t.Fatal("canvas must read exactly its retained workflow lock file once")
			}
		})
	}
}
