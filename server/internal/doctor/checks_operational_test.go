package doctor

import (
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

func TestOperationalMemoryDoctorUsesOwningStateAndSkipsRedisProviderChecks(t *testing.T) {
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	d := Doctor{Backend: "memory", Store: store, Namespace: "memory", Getenv: func(string) string { return "" }}
	report := d.Run(t.Context())
	if report.Redis != "(not selected)" {
		t.Fatalf("memory reported a Redis connection: %q", report.Redis)
	}
	foundHealth, foundGuarantees := false, false
	for _, check := range report.Checks {
		if strings.HasPrefix(check.ID, "redis.") {
			t.Fatalf("memory performed a Redis provider check: %+v", check)
		}
		if check.ID == "operational.health" {
			foundHealth = true
			if check.Status != StatusPass {
				t.Fatalf("owning memory state not healthy: %+v", check)
			}
		}
		if check.ID == "operational.capabilities" {
			foundGuarantees = true
			if check.Status != StatusWarn || !strings.Contains(check.Summary, "lost on restart") {
				t.Fatalf("memory persistence limitations not reported: %+v", check)
			}
		}
	}
	if !foundHealth || !foundGuarantees {
		t.Fatal("operational health or guarantees missing")
	}
}

func TestOperationalMemoryDoctorDoesNotInventHealthyDisconnectedState(t *testing.T) {
	d := Doctor{Backend: "memory"}
	check := d.checkOperational(t.Context())
	if check.Status != StatusFail || !strings.Contains(check.Remedy, "owning process") {
		t.Fatalf("disconnected memory diagnostics appeared healthy: %+v", check)
	}
}
