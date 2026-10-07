package doctor

import (
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

type focusedDoctorStore struct {
	operational.Backend
	services operational.OperationalServices
}

func (s focusedDoctorStore) OperationalServices() operational.OperationalServices {
	return s.services
}

func TestDoctorRejectsIncompleteFocusedServices(t *testing.T) {
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	for name, remove := range map[string]func(*operational.OperationalServices){
		"health":    func(s *operational.OperationalServices) { s.Health = nil },
		"queue":     func(s *operational.OperationalServices) { s.Queue = nil },
		"admission": func(s *operational.OperationalServices) { s.Admission = nil },
	} {
		t.Run(name, func(t *testing.T) {
			services := store.OperationalServices()
			remove(&services)
			d := Doctor{Backend: "memory", Store: focusedDoctorStore{Backend: store, services: services}}
			if check := d.checkOperational(t.Context()); check.Status != StatusFail {
				t.Fatalf("incomplete operational services appeared healthy: %+v", check)
			}
			if check := d.checkOperationalCapabilities(t.Context()); check.Status != StatusFail {
				t.Fatalf("incomplete operational capabilities accepted: %+v", check)
			}
		})
	}
}

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

func TestSummarizeOperationalCapabilitiesAllSupportedRestart(t *testing.T) {
	restart := operational.Capability{Scope: operational.ScopeDeployment, Persistence: operational.PersistenceRestart}
	caps := operational.Capabilities{
		Cache: restart, RequestLimits: restart, Sessions: restart, Revocations: restart,
		GitHubQuota: restart, Collection: restart, Coordination: restart, Diagnostics: restart,
	}
	details, volatile := summarizeOperationalCapabilities(caps)
	if volatile {
		t.Fatalf("all-restart capabilities reported volatile: %+v", details)
	}
	if len(details) != 8 {
		t.Fatalf("expected 8 feature details, got %d: %+v", len(details), details)
	}
	for _, d := range details {
		if d.Value != "deployment/restart" {
			t.Fatalf("expected deployment/restart detail, got %+v", d)
		}
	}
}

func TestSummarizeOperationalCapabilitiesFlagsSupportedVolatile(t *testing.T) {
	caps := operational.Capabilities{
		Cache: operational.Capability{Scope: operational.ScopeProcess, Persistence: operational.PersistenceVolatile},
	}
	details, volatile := summarizeOperationalCapabilities(caps)
	if !volatile {
		t.Fatalf("supported volatile cache capability was not flagged: %+v", details)
	}
}

func TestSummarizeOperationalCapabilitiesIgnoresUnsupportedVolatile(t *testing.T) {
	// An unsupported feature is always reported as volatile internally, but
	// that should never count toward the overall volatile warning because
	// the feature was never offered in the first place.
	caps := operational.Capabilities{}
	details, volatile := summarizeOperationalCapabilities(caps)
	if volatile {
		t.Fatalf("unsupported capabilities incorrectly flagged volatile: %+v", details)
	}
	for _, d := range details {
		if d.Value != "unsupported/volatile" {
			t.Fatalf("expected unsupported/volatile detail, got %+v", d)
		}
	}
}
