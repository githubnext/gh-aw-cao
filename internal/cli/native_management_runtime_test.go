package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeRuntimeArchiveFixture(t *testing.T, revision string, corrupt bool) string {
	t.Helper()
	files := map[string]string{}
	for _, name := range nativeRuntimeRequiredFiles {
		files[name] = "bundled: " + name
	}
	for _, name := range nativeRuntimeResources {
		if name == "activity" || name == "dashboard" {
			continue
		}
		if name == ".github/actions/setup-cao-runtime" || name == ".github/actions/setup-gh-aw" {
			name += "/action.yml"
		}
		files[name] = "resource: " + name
	}
	hashes := map[string]string{}
	for name, content := range files {
		hashes[name] = nativeDownloadDigest(content)
	}
	metadata, err := json.Marshal(map[string]any{
		"schemaVersion": 1, "repository": catalogRepository, "revision": revision, "files": hashes,
	})
	if err != nil {
		t.Fatal(err)
	}
	files["cao-runtime.json"] = string(metadata)
	if corrupt {
		files["activity/cao.mjs"] += "tampered"
	}
	archive := map[string]string{}
	for name, content := range files {
		archive["package/"+name] = content
	}
	return campaignArchive(t, archive)
}

func TestNativeManagementRuntimeAttestationAndHashChecks(t *testing.T) {
	for _, failure := range []string{"", "attestation", "hash"} {
		t.Run(failure, func(t *testing.T) {
			nativeManagementDirectory(t)
			revision := strings.Repeat("c", 40)
			writeTestFile(t, ".github/aw/packages/root.json", `{"package":"githubnext/gh-aw-cao","source":"githubnext/gh-aw-cao@v1.2.3","resolvedCommit":"`+revision+`"}`)
			writeTestFile(t, "activity/existing", "operator original")
			archive := nativeRuntimeArchiveFixture(t, revision, failure == "hash")
			attested := false
			gh := func(_ context.Context, args ...string) (string, string, error) {
				switch args[0] {
				case "release":
					for index, arg := range args {
						if arg == "--dir" {
							writeTestFile(t, filepath.Join(args[index+1], "cao-runtime-"+revision+".tgz"), archive)
						}
					}
					return "", "", nil
				case "attestation":
					attested = true
					joined := strings.Join(args, " ")
					if !strings.Contains(joined, "--source-digest "+revision) || !strings.Contains(joined, "--signer-digest "+revision) || !strings.Contains(joined, "--deny-self-hosted-runners") {
						t.Fatalf("incomplete provenance verification %q", args)
					}
					if failure == "attestation" {
						return "", "invalid provenance", errors.New("rejected")
					}
					return "", "", nil
				default:
					t.Fatalf("unexpected runtime command %q", args)
					return "", "", nil
				}
			}
			err := nativeMaterializeRuntime(context.Background(), gh, "root")
			if (err == nil) != (failure == "") || !attested {
				t.Fatalf("runtime error = %v, attested = %v", err, attested)
			}
			if failure != "" {
				content, err := os.ReadFile("activity/existing")
				if err != nil || string(content) != "operator original" {
					t.Fatal("unverified runtime replaced installed resources")
				}
			} else {
				for _, name := range nativeRuntimeRequiredFiles {
					if _, err := os.Stat(name); err != nil {
						t.Fatalf("runtime is missing %s", name)
					}
				}
				if _, err := os.Stat("activity/existing"); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("retired runtime resource survived replacement")
				}
			}
		})
	}
}

func TestNativeManagementRuntimeRejectsUnsafeArchive(t *testing.T) {
	for _, test := range []struct {
		name, entry string
		kind        byte
	}{
		{"traversal", "package/../outside", tar.TypeReg},
		{"symlink", "package/activity/symlink", tar.TypeSymlink},
		{"hardlink", "package/activity/hardlink", tar.TypeLink},
		{"unowned", "package/.github/workflows/unauthorized.yml", tar.TypeReg},
	} {
		t.Run(test.name, func(t *testing.T) {
			nativeManagementDirectory(t)
			var archive bytes.Buffer
			compressed := gzip.NewWriter(&archive)
			writer := tar.NewWriter(compressed)
			if err := writer.WriteHeader(&tar.Header{Name: test.entry, Typeflag: test.kind, Mode: 0o644, Linkname: "outside"}); err != nil {
				t.Fatal(err)
			}

			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := compressed.Close(); err != nil {
				t.Fatal(err)
			}
			writeTestFile(t, "runtime.tgz", archive.String())
			if err := os.Mkdir("extracted", 0o755); err != nil {
				t.Fatal(err)
			}
			if _, err := nativeExtractRuntime(context.Background(), "runtime.tgz", "extracted"); err == nil {
				t.Fatal("unsafe runtime archive was accepted")
			}
		})
	}
}

func TestNativeManagementRuntimeArtifactExpiryIsExplicit(t *testing.T) {
	for _, test := range []struct {
		name, expiration string
		selected         bool
	}{
		{"unexpired", `,"expired":false`, true},
		{"expired", `,"expired":true`, false},
		{"unknown", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			nativeManagementDirectory(t)
			revision := strings.Repeat("d", 40)
			downloaded := false
			gh := func(_ context.Context, args ...string) (string, string, error) {
				joined := strings.Join(args, " ")
				switch {
				case args[0] == "run":
					downloaded = true
					return "", "test stops before download", errors.New("stopped")
				case strings.Contains(joined, "/artifacts?"):
					return `[{"artifacts":[{"name":"cao-runtime-` + revision + `"` + test.expiration + `}]}]`, "", nil
				default:
					return `[{"workflow_runs":[{"id":1,"head_sha":"` + revision + `","event":"push","status":"completed","conclusion":"success"}]}]`, "", nil
				}
			}
			_, err := nativeAcquireRuntime(context.Background(), gh, nativePackageRecord{source: catalogRepository + "@main", revision: revision}, ".")
			if err == nil || downloaded != test.selected {
				t.Fatalf("artifact selected = %v (expected %v), error = %v", downloaded, test.selected, err)
			}
		})
	}
}
