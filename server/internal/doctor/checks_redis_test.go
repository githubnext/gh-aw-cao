package doctor

import "testing"

func TestMemoryVerdictFailsOnEvictionPolicy(t *testing.T) {
	outcome := memoryVerdict(734003200, 1073741824, "allkeys-lru")
	if outcome.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", outcome.Status, outcome)
	}
	if outcome.Remedy == "" {
		t.Fatal("expected a remedy for a non-noeviction policy")
	}
}

func TestMemoryVerdictFailsAboveNinetyFivePercentUtilization(t *testing.T) {
	outcome := memoryVerdict(980, 1000, "noeviction")
	if outcome.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", outcome.Status, outcome)
	}
}

func TestMemoryVerdictWarnsAboveEightyPercentUtilization(t *testing.T) {
	outcome := memoryVerdict(850, 1000, "noeviction")
	if outcome.Status != StatusWarn {
		t.Fatalf("status = %s, want warn: %+v", outcome.Status, outcome)
	}
}

func TestMemoryVerdictPassesUnderEightyPercentUtilizationWithNoEviction(t *testing.T) {
	outcome := memoryVerdict(100, 1000, "noeviction")
	if outcome.Status != StatusPass {
		t.Fatalf("status = %s, want pass: %+v", outcome.Status, outcome)
	}
	if outcome.Remedy != "" {
		t.Fatalf("expected no remedy for a passing check, got %q", outcome.Remedy)
	}
}

func TestMemoryVerdictWarnsWhenNoMaxmemoryIsConfigured(t *testing.T) {
	outcome := memoryVerdict(100, 0, "noeviction")
	if outcome.Status != StatusWarn {
		t.Fatalf("status = %s, want warn: %+v", outcome.Status, outcome)
	}
	if outcome.Remedy == "" {
		t.Fatal("expected a remedy for an unbounded memory limit")
	}
}

func TestMemoryVerdictTreatsEmptyPolicyAsNoeviction(t *testing.T) {
	outcome := memoryVerdict(100, 1000, "")
	if outcome.Status != StatusPass {
		t.Fatalf("status = %s, want pass for an empty (unset) policy: %+v", outcome.Status, outcome)
	}
}
