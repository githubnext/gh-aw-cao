package cli

import (
	"context"
	"errors"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestSetupCommandHierarchy(t *testing.T) {
	root, _, _ := testCommand(t, nil, nil)
	for _, tt := range []struct {
		path, want []string
	}{
		{[]string{"setup"}, []string{"auth"}},
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
