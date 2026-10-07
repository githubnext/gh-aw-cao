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

func TestClassifyMissingConfigReportsEachBlankFieldInPrecedenceOrder(t *testing.T) {
	complete := Config{
		SiteDirectory:        "site",
		DashboardQueriesPath: "dashboard.json",
		DatabaseQueriesPath:  "database.json",
	}

	cases := []struct {
		name   string
		mutate func(Config) Config
		want   missingConfigField
	}{
		{
			name:   "all fields present",
			mutate: func(c Config) Config { return c },
			want:   missingConfigFieldNone,
		},
		{
			name:   "missing site directory",
			mutate: func(c Config) Config { c.SiteDirectory = ""; return c },
			want:   missingConfigFieldSiteDirectory,
		},
		{
			name:   "missing dashboard queries",
			mutate: func(c Config) Config { c.DashboardQueriesPath = ""; return c },
			want:   missingConfigFieldDashboardQueries,
		},
		{
			name:   "missing database queries",
			mutate: func(c Config) Config { c.DatabaseQueriesPath = ""; return c },
			want:   missingConfigFieldDatabaseQueries,
		},
		{
			name: "site directory takes precedence over other missing fields",
			mutate: func(c Config) Config {
				c.SiteDirectory = ""
				c.DashboardQueriesPath = ""
				c.DatabaseQueriesPath = ""
				return c
			},
			want: missingConfigFieldSiteDirectory,
		},
		{
			name: "dashboard queries takes precedence over database queries",
			mutate: func(c Config) Config {
				c.DashboardQueriesPath = ""
				c.DatabaseQueriesPath = ""
				return c
			},
			want: missingConfigFieldDashboardQueries,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyMissingConfig(tc.mutate(complete))
			if got != tc.want {
				t.Fatalf("classifyMissingConfig() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNewRejectsProcessOwnedHostPolicy(t *testing.T) {
	t.Setenv("CAO_POLICY_PATH", "../../.github/workflows/cao.coolify.json")
	t.Setenv("CAO_POSTGRES_URL", "postgres://127.0.0.1/example?sslmode=disable")
	if _, err := New(t.Context(), Config{
		SiteDirectory:        t.TempDir(),
		DashboardQueriesPath: "../../dashboard/site/dashboard.json",
		DatabaseQueriesPath:  "../../dashboard/site/src/data/queries/database.json",
	}); err == nil || !strings.Contains(err.Error(), "does not delegate listener ownership") {
		t.Fatalf("accepted a process-owned host policy: %v", err)
	}
}
