package localops

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestLegacyOperatorArgumentsRouteToNativeCommandGroups(t *testing.T) {
	for _, row := range []struct {
		command string
		want    []string
	}{
		{"./cao.sh mode live test-campaign", []string{"campaigns", "mode", "live", "test-campaign"}},
		{"./cao.sh mode preview test-campaign", []string{"campaigns", "mode", "preview", "test-campaign"}},
		{"./cao.sh enable test-campaign", []string{"campaigns", "enable", "test-campaign"}},
		{"./cao.sh disable test-campaign", []string{"campaigns", "disable", "test-campaign"}},
		{"./cao.sh add owner/catalog/campaign@main --force", []string{"campaigns", "add", "owner/catalog/campaign@main", "--force"}},
		{"./cao.sh add --repository owner/repo", []string{"repos", "add", "owner/repo"}},
		{"./cao.sh add --repository=owner/repo", []string{"repos", "add", "owner/repo"}},
		{"gh cao campaigns mode preview test-campaign", []string{"campaigns", "mode", "preview", "test-campaign"}},
		{"gh cao repos add owner/repo", []string{"repos", "add", "owner/repo"}},
		{"gh-cao campaigns enable test-campaign", []string{"campaigns", "enable", "test-campaign"}},
		{"./cao.sh update --pr", []string{"update", "--pr"}},
	} {
		tokens, err := ParseCommand(row.command)
		if err != nil {
			t.Fatal(err)
		}
		original := append([]string{}, tokens...)
		if got := nativeOperatorArguments(tokens); !reflect.DeepEqual(got, row.want) {
			t.Fatalf("%s: %v != %v", row.command, got, row.want)
		}
		if !reflect.DeepEqual(tokens, original) {
			t.Fatal("native routing changed the parsed approved identity")
		}
	}
}

func TestLegacyOperatorExecutionPreservesApprovedAndPersistedIdentity(t *testing.T) {
	t.Setenv("LOCALOPS_CAPTURE_OPERATOR", "1")
	legacy := "./cao.sh mode preview test-campaign"
	document := fixtureDocument()
	actionByID(document, "complete")["command"] = legacy
	approved := ""
	s := service(t, func(o *Options) {
		o.Dashboard = func() map[string]any { return document }
		o.Approve = func(_ context.Context, invocation Invocation) (bool, error) {
			approved = invocation.Command
			return true, nil
		}
	})
	value := enqueue(t, s, "complete")
	completed := waitJob(t, s, value["id"], "completed")
	if approved != legacy || completed["command"] != legacy {
		t.Fatal("native routing changed command identity")
	}
	var actual []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(text(completed["stdout"]))), &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, []string{"campaigns", "mode", "preview", "test-campaign"}) {
		t.Fatal(actual)
	}
}
