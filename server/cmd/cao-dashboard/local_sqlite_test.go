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
