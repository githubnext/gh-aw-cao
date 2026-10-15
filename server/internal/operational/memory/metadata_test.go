package memory

import "testing"

func TestDecideOwnerTransferBlankPreviousNeverTransfers(t *testing.T) {
	decision := decideOwnerTransfer("install:", ":repos", 2, "")
	if decision.transfers {
		t.Fatalf("decision = %+v, want no transfer for blank previous owner", decision)
	}
	if decision.oldSet != "" {
		t.Fatalf("oldSet = %q, want empty", decision.oldSet)
	}
}

func TestDecideOwnerTransferNonNumericPreviousNeverTransfers(t *testing.T) {
	decision := decideOwnerTransfer("install:", ":repos", 2, "not-a-number")
	if decision.transfers {
		t.Fatalf("decision = %+v, want no transfer for non-numeric previous owner", decision)
	}
}

func TestDecideOwnerTransferNonPositivePreviousNeverTransfers(t *testing.T) {
	for _, previous := range []string{"0", "-1"} {
		decision := decideOwnerTransfer("install:", ":repos", 2, previous)
		if decision.transfers {
			t.Fatalf("previous=%q: decision = %+v, want no transfer for non-positive previous owner", previous, decision)
		}
	}
}

func TestDecideOwnerTransferSameInstallationNeverTransfers(t *testing.T) {
	decision := decideOwnerTransfer("install:", ":repos", 2, "2")
	if decision.transfers {
		t.Fatalf("decision = %+v, want no transfer when previous owner matches the new installation", decision)
	}
}

func TestDecideOwnerTransferDistinctInstallationTransfersWithOldSet(t *testing.T) {
	decision := decideOwnerTransfer("install:", ":repos", 2, "1")
	if !decision.transfers {
		t.Fatalf("decision = %+v, want a transfer for a distinct previous installation", decision)
	}
	if decision.oldSet != "install:1:repos" {
		t.Fatalf("oldSet = %q, want %q", decision.oldSet, "install:1:repos")
	}
}
