package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func campaignArchive(t *testing.T, files map[string]string) string {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(compressed)
	for name, content := range files {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.String()
}

func TestCampaignArchiveGitHubGlobalPAXHeader(t *testing.T) {
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(compressed)
	for _, header := range []*tar.Header{
		{Name: "pax_global_header", Typeflag: tar.TypeXGlobalHeader, PAXRecords: map[string]string{"comment": testCampaignSHA}},
		{Name: "catalog/", Typeflag: tar.TypeDir},
		{Name: "catalog/demo/", Typeflag: tar.TypeDir},
		{Name: "catalog/demo/cao.json", Mode: 0o644, Size: int64(len(testCampaignDeclaration))},
	} {
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size != 0 {
			if _, err := writer.Write([]byte(testCampaignDeclaration)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	if err := stageCampaignArchive(context.Background(), &buffer, staging, "demo"); err != nil {
		t.Fatal(err)
	}
	if _, err := readCampaignDeclaration(filepath.Join(staging, "demo"), "demo"); err != nil {
		t.Fatal(err)
	}
}

func TestCampaignSlug(t *testing.T) {
	for spec, want := range map[string]string{
		"githubnext/gh-cao/demo@feature/config":        "demo",
		"https://github.com/githubnext/gh-cao/demo@v1": "demo",
		"./demo/": "demo", "demo": "demo", "/space dir/demo": "demo",
	} {
		if got, err := campaignSlug(spec); err != nil || got != want {
			t.Fatalf("campaignSlug(%q) = %q, %v", spec, got, err)
		}
	}
}

func TestInstalledCampaignRevision(t *testing.T) {
	t.Chdir(t.TempDir())
	campaignRecord(t, "campaigns", strings.Repeat("a", 40))
	campaignRecord(t, "packages", strings.ToUpper(testCampaignSHA))
	if got, err := installedCampaignRevision("demo"); err != nil || got != testCampaignSHA {
		t.Fatalf("package must override legacy record: %q %v", got, err)
	}
	for _, revision := range []string{"", "main", "abc123", strings.Repeat("x", 40)} {
		campaignRecord(t, "packages", revision)
		if _, err := installedCampaignRevision("demo"); err == nil || !strings.Contains(err.Error(), "full resolvedCommit SHA") {
			t.Fatalf("invalid revision accepted: %q, %v", revision, err)
		}
	}
	for _, field := range []string{"campaign", "source"} {
		record := `{"` + field + `":"githubnext/gh-cao/demo@v1","resolvedCommit":"` + testCampaignSHA + `"}`
		if field == "campaign" {
			record = strings.ReplaceAll(record, "demo@v1", "demo")
		}
		writeTestFile(t, ".github/aw/packages/demo.json", record)
		if got, err := installedCampaignRevision("demo"); err != nil || got != testCampaignSHA {
			t.Fatalf("legacy %s record: %q %v", field, got, err)
		}
	}
	if _, err := installedCampaignRevision("other"); err == nil {
		t.Fatal("missing record accepted")
	}
	writeTestFile(t, ".github/aw/packages/demo.json", "{")
	if _, err := installedCampaignRevision("demo"); err == nil || !strings.Contains(err.Error(), "invalid JSON") {
		t.Fatalf("malformed record accepted: %v", err)
	}
}

func TestCampaignMaterializationRejectsEscapingDestinations(t *testing.T) {
	for _, destination := range []string{"demo", ".github/aw/packages", ".github/cao/intelligence"} {
		t.Run(destination, func(t *testing.T) {
			t.Chdir(t.TempDir())
			outside := t.TempDir()
			writeTestFile(t, filepath.Join(outside, "preserved.txt"), "outside")
			if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, destination); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			gh := func(context.Context, ...string) (string, string, error) {
				t.Fatal("unsafe destination must be rejected before downloading")
				return "", "", nil
			}
			if _, err := materializeCampaign(context.Background(), gh, "demo", ""); err == nil || !strings.Contains(err.Error(), "escapes") {
				t.Fatalf("unsafe destination accepted: %v", err)
			}
			if content, err := os.ReadFile(filepath.Join(outside, "preserved.txt")); err != nil || string(content) != "outside" {
				t.Fatalf("outside data changed: %q, %v", content, err)
			}
		})
	}
}

func TestCampaignArchiveRejectsUnsafeEntries(t *testing.T) {
	for _, tt := range []struct {
		name    string
		headers []*tar.Header
	}{
		{"traversal", []*tar.Header{{Name: "catalog/demo/../../outside"}}},
		{"absolute", []*tar.Header{{Name: "/catalog/demo/cao.json"}}},
		{"windows traversal", []*tar.Header{{Name: `catalog/demo/..\outside`}}},
		{"symlink", []*tar.Header{{Name: "catalog/demo/link", Typeflag: tar.TypeSymlink, Linkname: "../../outside"}}},
		{"hardlink", []*tar.Header{{Name: "catalog/demo/link", Typeflag: tar.TypeLink, Linkname: "catalog/demo/cao.json"}}},
		{"multiple roots", []*tar.Header{{Name: "catalog/demo/one"}, {Name: "another/demo/two"}}},
		{"duplicate file", []*tar.Header{{Name: "catalog/demo/one"}, {Name: "catalog/demo/one"}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var buffer bytes.Buffer
			compressed := gzip.NewWriter(&buffer)
			writer := tar.NewWriter(compressed)
			for _, header := range tt.headers {
				if err := writer.WriteHeader(header); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := compressed.Close(); err != nil {
				t.Fatal(err)
			}
			if err := stageCampaignArchive(context.Background(), &buffer, t.TempDir(), "demo"); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}

func TestCampaignMaterializationFailures(t *testing.T) {
	for _, name := range []string{"download", "missing declaration", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			campaignRecord(t, "packages", testCampaignSHA)
			writeTestFile(t, "demo/preserved.txt", "original")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if name == "cancelled" {
				cancel()
			}
			gh := func(context.Context, ...string) (string, string, error) {
				if name == "download" {
					return "", "network unavailable", errors.New("failed")
				}
				return campaignArchive(t, map[string]string{"catalog/demo/other": "no declaration"}), "", nil
			}
			if _, err := materializeCampaign(ctx, gh, "demo", ""); err == nil {
				t.Fatal("expected materialization failure")
			}
			if content, err := os.ReadFile("demo/preserved.txt"); err != nil || string(content) != "original" {
				t.Fatalf("campaign changed on failed staging: %q %v", content, err)
			}
		})
	}
}

func TestMergeCampaignReplacesInvalidWorkerShapes(t *testing.T) {
	for _, old := range []string{`[]`, `null`, `"invalid"`, `{"workers":[]}`, `{"workers":{"first":{"enabled":"yes","max-mode":"debug"}}}`} {
		t.Run(old, func(t *testing.T) {
			t.Chdir(t.TempDir())
			writeTestFile(t, policyPath, `{"version":1,"control-plane":{"campaigns":{"demo":`+old+`}}}`)
			policy, err := readPolicy()
			if err != nil {
				t.Fatal(err)
			}
			declaration := &campaignDeclaration{Campaign: "demo", Orchestrator: "demo", Workers: []campaignWorker{{Name: "first", Workflow: "demo-first"}}}
			mergeCampaignDeclaration(policy, declaration)
			if err := writePolicy(policy, false); err != nil {
				t.Fatal(err)
			}
			policy, err = readPolicy()
			if err != nil {
				t.Fatal(err)
			}
			demo := policy["control-plane"].(map[string]any)["campaigns"].(map[string]any)["demo"].(map[string]any)
			if want := map[string]any{"first": map[string]any{"workflow": "demo-first"}}; !reflect.DeepEqual(demo["workers"], want) {
				t.Fatalf("workers = %v", demo["workers"])
			}
		})
	}
}
