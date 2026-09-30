package hosting

import (
	"strings"
	"testing"
)

func TestNewRequiresExplicitPaths(t *testing.T) {
	if _, err := New(t.Context(), Config{}); err == nil ||
		!strings.Contains(err.Error(), "requires site") {
		t.Fatalf("accepted missing site and query definitions: %v", err)
	}
}

func TestNewRejectsProcessOwnedHostPolicy(t *testing.T) {
	t.Setenv("CAO_POLICY_PATH", "../../.github/workflows/cao.coolify.json")
	t.Setenv("REDIS_URL", "redis://redis:6379")
	if _, err := New(t.Context(), Config{
		SiteDirectory:        t.TempDir(),
		DashboardQueriesPath: "../../dashboard/site/dashboard.json",
		DatabaseQueriesPath:  "../../dashboard/site/src/data/queries/database.json",
	}); err == nil || !strings.Contains(err.Error(), "does not delegate listener ownership") {
		t.Fatalf("accepted a process-owned host policy: %v", err)
	}
}
