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
