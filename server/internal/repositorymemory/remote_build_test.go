package repositorymemory

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
)

func TestBuildRemoteCampaignAdmitsValidBlobs(t *testing.T) {
	entries := []githubapp.GitTreeEntry{
		{Path: "notes.md", OID: "a", Mode: "100644", Type: "blob", Size: 5},
		{Path: "script.sh", OID: "b", Mode: "100755", Type: "blob", Size: 3},
	}
	campaign := buildRemoteCampaign("example", "deadbeef", entries, false)
	if campaign.Campaign != "example" || campaign.Branch != "memory/example" || campaign.Commit != "deadbeef" {
		t.Fatalf("unexpected campaign identity: %#v", campaign)
	}
	if len(campaign.Files) != 1 || campaign.Files[0].Path != "notes.md" {
		t.Fatalf("unexpected files: %#v", campaign.Files)
	}
	if campaign.Omitted.Extension != 1 {
		t.Fatalf("expected the disallowed extension to be counted, got %#v", campaign.Omitted)
	}
}

func TestBuildRemoteCampaignMarksTruncatedTreeAsFileLimit(t *testing.T) {
	campaign := buildRemoteCampaign("example", "deadbeef", nil, true)
	if campaign.Omitted.FileLimit != 1 {
		t.Fatalf("truncated tree was not counted as a file-limit omission: %#v", campaign.Omitted)
	}
}

func TestBuildRemoteCampaignRejectsNonBlobAndSymlinkModes(t *testing.T) {
	entries := []githubapp.GitTreeEntry{
		{Path: "sub/notes.md", OID: "a", Mode: "040000", Type: "tree", Size: 0},
		{Path: "link.md", OID: "b", Mode: "120000", Type: "blob", Size: 5},
	}
	campaign := buildRemoteCampaign("example", "deadbeef", entries, false)
	if len(campaign.Files) != 0 {
		t.Fatalf("expected no admitted files, got %#v", campaign.Files)
	}
	if campaign.Omitted.UnsupportedType != 2 {
		t.Fatalf("expected both entries counted as unsupported type, got %#v", campaign.Omitted)
	}
}

func TestBuildRemoteCampaignEnforcesFileSizeLimit(t *testing.T) {
	entries := []githubapp.GitTreeEntry{
		{Path: "big.md", OID: "a", Mode: "100644", Type: "blob", Size: MaxFileSize + 1},
		{Path: "negative.md", OID: "b", Mode: "100644", Type: "blob", Size: -1},
	}
	campaign := buildRemoteCampaign("example", "deadbeef", entries, false)
	if len(campaign.Files) != 0 {
		t.Fatalf("expected no admitted files, got %#v", campaign.Files)
	}
	if campaign.Omitted.FileSize != 2 {
		t.Fatalf("expected both entries counted as file-size omissions, got %#v", campaign.Omitted)
	}
}

func TestBuildRemoteCampaignEnforcesFileCountLimit(t *testing.T) {
	entries := make([]githubapp.GitTreeEntry, 0, MaxFileCount+1)
	for i := 0; i <= MaxFileCount; i++ {
		entries = append(entries, githubapp.GitTreeEntry{
			Path: pathFor(i), OID: "a", Mode: "100644", Type: "blob", Size: 1,
		})
	}
	campaign := buildRemoteCampaign("example", "deadbeef", entries, false)
	if len(campaign.Files) != MaxFileCount {
		t.Fatalf("expected admitted files capped at %d, got %d", MaxFileCount, len(campaign.Files))
	}
	if campaign.Omitted.FileLimit != 1 {
		t.Fatalf("expected the excess entry counted as a file-limit omission, got %#v", campaign.Omitted)
	}
}

func TestBuildRemoteCampaignEnforcesTotalSizeLimit(t *testing.T) {
	// Fill the total-size budget exactly with entries at the per-file size
	// limit, then add one more small entry that must overflow it. Each
	// individual size stays within MaxFileSize so only the aggregate
	// MaxTotalSize case is exercised.
	fillers := int(MaxTotalSize / MaxFileSize)
	entries := make([]githubapp.GitTreeEntry, 0, fillers+1)
	for i := 0; i < fillers; i++ {
		entries = append(entries, githubapp.GitTreeEntry{
			Path: pathFor(i), OID: "a", Mode: "100644", Type: "blob", Size: MaxFileSize,
		})
	}
	entries = append(entries, githubapp.GitTreeEntry{
		Path: "overflow.md", OID: "b", Mode: "100644", Type: "blob", Size: 1,
	})
	campaign := buildRemoteCampaign("example", "deadbeef", entries, false)
	if len(campaign.Files) != fillers {
		t.Fatalf("expected %d admitted files, got %d", fillers, len(campaign.Files))
	}
	if campaign.Omitted.TotalSize != 1 {
		t.Fatalf("expected the overflow entry counted as a total-size omission, got %#v", campaign.Omitted)
	}
}

func pathFor(i int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	return string(letters[i%len(letters)]) + string(rune('0'+i/len(letters))) + ".md"
}

func TestClassifyRemotePathRejectsEmptyAbsoluteAndBackslashPaths(t *testing.T) {
	for _, value := range []string{"", "/abs.md", `dir\file.md`} {
		omitted := Omissions{}
		classifyRemotePath(value, &omitted)
		if omitted.UnsafePath != 1 {
			t.Fatalf("path %q was not rejected as unsafe: %#v", value, omitted)
		}
	}
}

func TestClassifyRemotePathRejectsExcessiveNesting(t *testing.T) {
	deep := ""
	for i := 0; i < MaxNesting+2; i++ {
		deep += "dir/"
	}
	deep += "file.md"
	omitted := Omissions{}
	classifyRemotePath(deep, &omitted)
	if omitted.Nesting != 1 {
		t.Fatalf("deeply nested path was not rejected: %#v", omitted)
	}
}

func TestClassifyRemotePathRejectsDotSegments(t *testing.T) {
	for _, value := range []string{"a/./b.md", "a/../b.md", "a//b.md"} {
		omitted := Omissions{}
		classifyRemotePath(value, &omitted)
		if omitted.UnsafePath != 1 {
			t.Fatalf("path %q with a dot segment was not rejected: %#v", value, omitted)
		}
	}
}

func TestClassifyRemotePathFallsBackToExtensionForOtherwiseSafePaths(t *testing.T) {
	omitted := Omissions{}
	classifyRemotePath("notes.exe", &omitted)
	if omitted.Extension != 1 {
		t.Fatalf("safe path with a disallowed extension was not counted: %#v", omitted)
	}
}

func TestTotalOmittedSumsEveryCategory(t *testing.T) {
	omitted := Omissions{
		FileLimit: 1, FileSize: 2, TotalSize: 3, Extension: 4,
		Nesting: 5, UnsafePath: 6, InvalidContent: 7, UnsupportedType: 8,
	}
	if got, want := totalOmitted(omitted), 36; got != want {
		t.Fatalf("totalOmitted() = %d, want %d", got, want)
	}
}

func TestTotalOmittedZeroForEmptyOmissions(t *testing.T) {
	if got := totalOmitted(Omissions{}); got != 0 {
		t.Fatalf("totalOmitted(Omissions{}) = %d, want 0", got)
	}
}
