package repositorymemory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadMissingManifest(t *testing.T) {
	snapshot, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manifest := decodeManifest(t, snapshot.Manifest)
	if manifest.Version != 1 || len(manifest.Campaigns) != 0 || len(snapshot.Files) != 0 {
		t.Fatalf("unexpected empty snapshot: %#v", snapshot)
	}
}

func TestLoadValidMemory(t *testing.T) {
	root := t.TempDir()
	content := []byte("# Memory\n")
	sum := sha256.Sum256(content)
	manifest := Manifest{
		Version: 1,
		Campaigns: []Campaign{{
			Campaign: "security-review",
			Branch:   "memory/security-review",
			Files: []File{{
				Path:   "notes/context.md",
				Size:   int64(len(content)),
				SHA256: hex.EncodeToString(sum[:]),
			}},
		}},
	}
	writeFixture(t, root, manifest, "security-review/notes/context.md", content)

	snapshot, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(snapshot.Files["security-review\x00notes/context.md"]); got != string(content) {
		t.Fatalf("content = %q", got)
	}
	loadedManifest := decodeManifest(t, snapshot.Manifest)
	if loadedManifest.Campaigns[0].Files[0].SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("hash was not preserved")
	}
}

func TestLoadComputesLegacyHash(t *testing.T) {
	root := t.TempDir()
	content := []byte("context")
	manifest := Manifest{
		Version: 1,
		Campaigns: []Campaign{{
			Campaign: "campaign",
			Branch:   "memory/campaign",
			Files:    []File{{Path: "context.txt", Size: int64(len(content))}},
		}},
	}
	writeFixture(t, root, manifest, "campaign/context.txt", content)

	snapshot, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if decodeManifest(t, snapshot.Manifest).Campaigns[0].Files[0].SHA256 == "" {
		t.Fatal("legacy manifest hash was not computed")
	}
}

func TestLoadRejectsInvalidMemory(t *testing.T) {
	tests := []struct {
		name     string
		file     File
		content  []byte
		manifest func(*Manifest)
		want     string
	}{
		{name: "unsafe path", file: File{Path: "../context.md", Size: 1}, content: []byte("x"), want: "is invalid"},
		{name: "extension", file: File{Path: "context.exe", Size: 1}, content: []byte("x"), want: "is invalid"},
		{name: "nesting", file: File{Path: strings.Repeat("a/", MaxNesting+1) + "context.md", Size: 1}, content: []byte("x"), want: "is invalid"},
		{name: "size", file: File{Path: "context.md", Size: MaxFileSize + 1}, content: []byte("x"), want: "is invalid"},
		{name: "utf8", file: File{Path: "context.md", Size: 1}, content: []byte{0xff}, want: "invalid size"},
		{name: "hash", file: File{Path: "context.md", Size: 1, SHA256: strings.Repeat("0", 64)}, content: []byte("x"), want: "hash"},
		{
			name:    "too many files",
			file:    File{Path: "context.md", Size: 1},
			content: []byte("x"),
			manifest: func(manifest *Manifest) {
				manifest.Campaigns[0].Files = make([]File, MaxFileCount+1)
			},
			want: "is invalid",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			manifest := Manifest{
				Version: 1,
				Campaigns: []Campaign{{
					Campaign: "campaign",
					Branch:   "memory/campaign",
					Files:    []File{test.file},
				}},
			}
			if test.manifest != nil {
				test.manifest(&manifest)
			}
			writeFixture(t, root, manifest, "campaign/"+test.file.Path, test.content)
			_, err := Load(root)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestLoadRejectsSymlinkedMemoryPath(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	content := []byte("context")
	manifest := Manifest{
		Version: 1,
		Campaigns: []Campaign{{
			Campaign: "campaign",
			Branch:   "memory/campaign",
			Files:    []File{{Path: "notes/context.txt", Size: int64(len(content))}},
		}},
	}
	writeFixture(t, root, manifest, "campaign/unused.txt", content)
	if err := os.WriteFile(filepath.Join(outside, "context.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "memory", "campaign", "notes")); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(root); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("error = %v, want unavailable symlink path", err)
	}
}

func decodeManifest(t *testing.T, data []byte) Manifest {
	t.Helper()
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func writeFixture(t *testing.T, root string, manifest Manifest, file string, content []byte) {
	t.Helper()
	for campaignIndex := range manifest.Campaigns {
		campaign := &manifest.Campaigns[campaignIndex]
		if campaign.Commit == "" {
			campaign.Commit = strings.Repeat("a", 40)
		}
		for fileIndex := range campaign.Files {
			if campaign.Files[fileIndex].OID == "" {
				campaign.Files[fileIndex].OID = strings.Repeat("b", 40)
			}
		}
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	memoryRoot := filepath.Join(root, "memory")
	if err := os.MkdirAll(memoryRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memoryRoot, "manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(memoryRoot, filepath.FromSlash(file))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
