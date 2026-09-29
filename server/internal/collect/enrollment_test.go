package collect

import "testing"

func TestNormalizeRepositoryCanonicalizesValidReference(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{name: "already canonical", value: "octo/repo", want: "octo/repo"},
		{name: "mixed case", value: "Octo/Repo", want: "octo/repo"},
		{name: "surrounding whitespace", value: "  octo/repo  ", want: "octo/repo"},
		{name: "dots underscores hyphens", value: "octo-org/repo_name.go", want: "octo-org/repo_name.go"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := NormalizeRepository(testCase.value)
			if err != nil {
				t.Fatalf("NormalizeRepository(%q) returned error: %v", testCase.value, err)
			}
			if got != testCase.want {
				t.Fatalf("NormalizeRepository(%q) = %q, want %q", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestNormalizeRepositoryRejectsMalformedReferences(t *testing.T) {
	cases := []string{
		"",
		"no-slash",
		"owner/",
		"/name",
		"owner/name/extra",
	}
	for _, value := range cases {
		t.Run(value, func(t *testing.T) {
			if _, err := NormalizeRepository(value); err == nil {
				t.Fatalf("NormalizeRepository(%q) succeeded, want error", value)
			}
		})
	}
}

func TestNormalizeRepositoryRejectsInvalidSegments(t *testing.T) {
	cases := []string{
		"./owner/name",
		"owner/.",
		"owner/..",
		"-owner/name",
		"owner/.name",
		"owner/na me",
		"ow!ner/name",
	}
	for _, value := range cases {
		t.Run(value, func(t *testing.T) {
			if _, err := NormalizeRepository(value); err == nil {
				t.Fatalf("NormalizeRepository(%q) succeeded, want error", value)
			}
		})
	}
}

func TestClassifyRepositoryRejectionDistinguishesReasons(t *testing.T) {
	cases := []struct {
		name       string
		owner      string
		nameField  string
		found      bool
		wantReason repositoryRejectionReason
		wantReject bool
	}{
		{name: "no slash found", owner: "octo", nameField: "", found: false, wantReason: repositoryRejectionReasonMalformed, wantReject: true},
		{name: "empty owner", owner: "", nameField: "repo", found: true, wantReason: repositoryRejectionReasonMalformed, wantReject: true},
		{name: "empty name", owner: "octo", nameField: "", found: true, wantReason: repositoryRejectionReasonMalformed, wantReject: true},
		{name: "extra slash in name", owner: "octo", nameField: "repo/extra", found: true, wantReason: repositoryRejectionReasonMalformed, wantReject: true},
		{name: "invalid owner segment", owner: "-octo", nameField: "repo", found: true, wantReason: repositoryRejectionReasonInvalidSegment, wantReject: true},
		{name: "invalid name segment", owner: "octo", nameField: "re po", found: true, wantReason: repositoryRejectionReasonInvalidSegment, wantReject: true},
		{name: "well-formed reference", owner: "octo", nameField: "repo", found: true, wantReject: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			reason, rejected := classifyRepositoryRejection(testCase.owner, testCase.nameField, testCase.found)
			if rejected != testCase.wantReject {
				t.Fatalf("rejected = %v, want %v", rejected, testCase.wantReject)
			}
			if rejected && reason != testCase.wantReason {
				t.Fatalf("reason = %q, want %q", reason, testCase.wantReason)
			}
		})
	}
}

func TestRepositoryTransferDetectsOwnershipChange(t *testing.T) {
	cases := []struct {
		name           string
		previous       string
		installationID int64
		wantPrevious   int64
		wantTransfer   bool
	}{
		{name: "no previous owner", previous: "", installationID: 7, wantTransfer: false},
		{name: "same owner", previous: "7", installationID: 7, wantTransfer: false},
		{name: "different owner", previous: "3", installationID: 7, wantPrevious: 3, wantTransfer: true},
		{name: "unparsable previous owner", previous: "not-a-number", installationID: 7, wantTransfer: false},
		{name: "non-positive previous owner", previous: "0", installationID: 7, wantTransfer: false},
		{name: "negative previous owner", previous: "-1", installationID: 7, wantTransfer: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			previousInstallation, transferred := repositoryTransfer(testCase.previous, testCase.installationID)
			if transferred != testCase.wantTransfer {
				t.Fatalf("transferred = %v, want %v", transferred, testCase.wantTransfer)
			}
			if transferred && previousInstallation != testCase.wantPrevious {
				t.Fatalf("previousInstallation = %d, want %d", previousInstallation, testCase.wantPrevious)
			}
		})
	}
}

func TestStaleRemovalDetectsMismatchedOwner(t *testing.T) {
	cases := []struct {
		name           string
		owner          string
		installationID int64
		wantStale      bool
	}{
		{name: "unowned repository", owner: "", installationID: 7, wantStale: false},
		{name: "matching owner", owner: "7", installationID: 7, wantStale: false},
		{name: "mismatched owner", owner: "3", installationID: 7, wantStale: true},
		{name: "unknown installation", owner: "3", installationID: 0, wantStale: false},
		{name: "negative installation", owner: "3", installationID: -1, wantStale: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := staleRemoval(testCase.owner, testCase.installationID); got != testCase.wantStale {
				t.Fatalf("staleRemoval(%q, %d) = %v, want %v",
					testCase.owner, testCase.installationID, got, testCase.wantStale)
			}
		})
	}
}
