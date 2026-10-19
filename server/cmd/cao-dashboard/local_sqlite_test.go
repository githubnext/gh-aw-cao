package main

import (
	"strings"
	"testing"
)

func TestServeSQLiteFlagValidation(t *testing.T) {
	t.Setenv("CAO_POLICY_PATH", "")
	t.Setenv("CAO_POSTGRES_URL", "")
	for _, test := range []struct {
		name string
		args []string
		want string
	}{
		{"empty", []string{"--sqlite="}, "--sqlite requires"},
		{"postgres", []string{"--sqlite=local.sqlite", "--postgres-url=postgres://localhost/test"}, "none of the others"},
		{"redis", []string{"--sqlite=local.sqlite", "--redis-url=redis://localhost"}, "none of the others"},
		{"source", []string{"--sqlite=local.sqlite", "--source=deployed"}, "none of the others"},
		{"public", []string{"--sqlite=local.sqlite", "--listen=0.0.0.0:8080"}, "non-loopback"},
		{"download-empty-url", []string{"--download-sqlite="}, "must use HTTP or HTTPS"},
		{"download-postgres", []string{"--download-sqlite", "--postgres-url=postgres://localhost/test"}, "none of the others"},
		{"download-redis", []string{"--download-sqlite", "--redis-url=redis://localhost"}, "none of the others"},
		{"download-source", []string{"--download-sqlite", "--source=deployed"}, "none of the others"},
		{"download-public", []string{"--download-sqlite", "--listen=0.0.0.0:8080"}, "non-loopback"},
		{"download-empty-path", []string{"--download-sqlite", "--sqlite="}, "--sqlite requires"},
		{"no-services", []string{"--sqlite=missing.sqlite",
			"--dashboard-queries=../../../dashboard/site/src/agent/queries.generated.json"}, "open canonical SQLite snapshot"},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd := newServeCommand()
			cmd.SilenceUsage, cmd.SilenceErrors = true, true
			cmd.SetArgs(test.args)
			err := cmd.ExecuteContext(t.Context())
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
		})
	}
}

func TestServeSQLiteDownloadURLArguments(t *testing.T) {
	t.Setenv("CAO_POLICY_PATH", "")
	t.Setenv("CAO_POSTGRES_URL", "invalid-unused-postgres")
	t.Setenv("CAO_REDIS_URL", "invalid-unused-redis")
	t.Setenv("OTEL_SDK_DISABLED", "true")
	for _, args := range [][]string{
		{"--download-sqlite"},
		{"--download-sqlite=https://owner.github.io/project/"},
		{"--download-sqlite", "https://owner.github.io/project/"},
		{"--sqlite=custom.sqlite", "--download-sqlite=https://custom.example.org/"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			cmd := newServeCommand()
			cmd.SilenceUsage, cmd.SilenceErrors = true, true
			cmd.SetArgs(append(args, "--dashboard-queries=missing-queries.json"))
			err := cmd.ExecuteContext(t.Context())
			if err == nil || !strings.Contains(err.Error(), "missing-queries.json") {
				t.Fatalf("download flags must select SQLite without database services: %v", err)
			}
		})
	}
}

func TestServeSQLiteDownloadEnvironmentURL(t *testing.T) {
	t.Setenv("DASHBOARD_DATA_URL", "https://custom.example.org/site")
	cmd := newServeCommand()
	if got := cmd.Flags().Lookup("download-sqlite").NoOptDefVal; got != "https://custom.example.org/site" {
		t.Fatalf("download URL default = %q", got)
	}
}
