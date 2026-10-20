package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestSetupAdmissionSharesConfiguration(t *testing.T) {
	for _, dryRun := range []bool{false, true} {
		calls := 0
		root, stdout, _ := testCommand(t, func(_ context.Context, args ...string) (string, string, error) {
			calls++
			if calls == 1 {
				return "[]", "", nil
			}
			if args[0] != "api" || strings.Contains(strings.Join(args, " "), "secret") {
				t.Fatal("admission attempted credential provisioning")
			}
			return "", "", nil
		}, nil)
		args := []string{"setup", "admission", "--repo", "acme/project", "--url", "https://cao.example/api/admission", "--json"}
		if dryRun {
			args = append(args, "--dry-run")
		}
		root.SetArgs(args)
		if err := root.ExecuteContext(t.Context()); err != nil {
			t.Fatal(err)
		}
		var report admissionCLIReport
		if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
			t.Fatal(err)
		}
		expectedCalls := 4
		if dryRun {
			expectedCalls = 1
		}
		if report.Applied == dryRun || report.Settings.OnOutage != "block" || calls != expectedCalls {
			t.Fatalf("setup admission diverged: %+v calls=%d", report, calls)
		}
	}
	root, stdout, _ := testCommand(t, nil, nil)
	root.SetArgs([]string{"setup", "admission", "--help"})
	if err := root.ExecuteContext(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "No PAT") || !strings.Contains(stdout.String(), "--dry-run") {
		t.Fatal("setup admission help omits secret boundary or preview flag")
	}
}

func TestSetupCommandHierarchy(t *testing.T) {
	root, _, _ := testCommand(t, nil, nil)
	for _, tt := range []struct {
		path, want []string
	}{
		{[]string{"setup"}, []string{"admission", "auth"}},
		{[]string{"setup", "auth"}, []string{"enterprise-app", "github-app", "token"}},
	} {
		cmd, remaining, err := root.Find(tt.path)
		if err != nil || len(remaining) != 0 {
			t.Fatalf("find %q: %v, remaining %q", tt.path, err, remaining)
		}
		var names []string
		for _, child := range cmd.Commands() {
			names = append(names, child.Name())
		}
		slices.Sort(names)
		if !reflect.DeepEqual(names, tt.want) {
			t.Fatalf("%q subcommands = %v, want %v", tt.path, names, tt.want)
		}
	}
}

func TestSetupAuthenticationIsNotRootCommand(t *testing.T) {
	for _, args := range [][]string{
		{"setup-auth"}, {"setup-auth", "token", "--dry-run"},
	} {
		root, stdout, stderr := testCommand(t, nil, nil)
		root.SetArgs(args)
		if err := root.Execute(); err == nil {
			t.Fatalf("%q: expected root-level authentication to be rejected", args)
		}
		if stdout.Len() != 0 || stderr.Len() != 0 {
			t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout, stderr)
		}
	}
}

func TestSetupPreservesRuntimeIOContextAndErrors(t *testing.T) {
	type key struct{}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), key{}, "setup"))
	defer cancel()
	for _, args := range [][]string{
		{"setup", "--json"},
		{"setup", "auth", "github-app"},
		{"setup", "auth", "enterprise-app"},
		{"setup", "auth", "token"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			want := errors.New("setup stopped")
			called := false
			root, stdout, stderr := testCommand(t, nil, func(cmd *cobra.Command, _ []string) error {
				called = true
				if cmd.Context() != ctx || cmd.Context().Value(key{}) != "setup" {
					t.Fatal("setup context changed")
				}
				input, err := io.ReadAll(cmd.InOrStdin())
				if err != nil || string(input) != "terminal input" {
					t.Fatalf("stdin changed: %q, %v", input, err)
				}
				if _, err := io.WriteString(cmd.OutOrStdout(), "result"); err != nil {
					t.Fatal(err)
				}
				if _, err := io.WriteString(cmd.ErrOrStderr(), "instructions"); err != nil {
					t.Fatal(err)
				}
				return want
			})
			root.SetIn(strings.NewReader("terminal input"))
			root.SetArgs(args)
			if err := root.ExecuteContext(ctx); !errors.Is(err, want) {
				t.Fatalf("runtime error changed: %v", err)
			}
			if !called || stdout.String() != "result" || stderr.String() != "instructions" {
				t.Fatalf("runtime streams changed: stdout=%q stderr=%q called=%v", stdout, stderr, called)
			}
		})
	}
}
