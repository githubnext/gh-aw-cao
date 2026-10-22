package cli

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSetupWorkflowTokenUsesDefaultsWithoutCredentialWrites(t *testing.T) {
	for _, test := range []struct {
		name, repository, organization, failure string
		reads, writes                           int
		wantError                               bool
	}{
		{name: "fresh", reads: 2},
		{name: "explicit workflow token", repository: `{"value":"workflow-token"}`, reads: 1},
		{name: "empty repository override", repository: `{"value":""}`, organization: `{"value":"app"}`, reads: 1},
		{name: "inherited workflow token", organization: `{"value":"workflow-token"}`, reads: 2},
		{name: "repository App", repository: `{"value":"app"}`, reads: 1, writes: 1},
		{name: "repository PAT", repository: `{"value":"pat"}`, reads: 1, writes: 1},
		{name: "inherited App", organization: `{"value":"app"}`, reads: 2, writes: 1},
		{name: "inherited PAT", organization: `{"value":"pat"}`, reads: 2, writes: 1},
		{name: "unknown mode", repository: `{"value":"future-mode"}`, reads: 1, writes: 1},
		{name: "unreadable repository", failure: "variables", reads: 1, wantError: true},
		{name: "unreadable organization", failure: "organization-variables", reads: 2, wantError: true},
		{name: "invalid JSON", repository: `{`, reads: 1, wantError: true},
		{name: "null response", repository: `null`, reads: 1, wantError: true},
		{name: "null mode", repository: `{"value":null}`, reads: 1, wantError: true},
		{name: "duplicate modes", repository: "{\"value\":\"app\"}\n{\"value\":\"pat\"}", reads: 1, wantError: true},
		{name: "failed override", repository: `{"value":"app"}`, failure: "write", reads: 1, writes: 1, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			reads, writes := 0, 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				if args[0] == "api" {
					reads++
					source := "variables"
					response := test.repository
					if strings.Contains(args[1], "/organization-variables?") {
						source, response = "organization-variables", test.organization
					}
					if test.failure == source {
						return "", "denied", errors.New("denied")
					}
					return response, "", nil
				}
				if strings.Join(args, " ") != "variable set GH_AW_GITHUB_AUTH_MODE --repo org/control --body workflow-token" {
					t.Fatalf("unexpected credential operation: %v", args)
				}
				writes++
				if test.failure == "write" {
					return "", "denied", errors.New("denied")
				}
				return "", "", nil
			}
			err := nativeSetupWorkflowToken(nativeSetupTestCommand(), gh, "org/control")
			if (err != nil) != test.wantError || reads != test.reads || writes != test.writes {
				t.Fatalf("error=%v reads=%d writes=%d, want error=%v reads=%d writes=%d",
					err, reads, writes, test.wantError, test.reads, test.writes)
			}
		})
	}
}
