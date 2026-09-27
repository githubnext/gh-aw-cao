package collect

import "testing"

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
