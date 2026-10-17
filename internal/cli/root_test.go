package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestCommands(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"root help", nil, "Configure and operate Central Agentic Ops"},
		{"help flag", []string{"--help"}, "gh cao [command]"},
		{"version flag", []string{"--version"}, "gh cao version test\n"},
		{"version command", []string{"version"}, "gh cao version test\n"},
		{"doctor help", []string{"doctor", "--help"}, "gh cao doctor"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := newRootCommand("test", func(context.Context) (string, error) {
				t.Fatal("help and version must not invoke gh")
				return "", nil
			})
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			root.SetArgs(tt.args)
			if err := root.ExecuteContext(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(stdout.String(), tt.want) {
				t.Fatalf("stdout = %q, want %q", stdout.String(), tt.want)
			}
			if stderr.Len() != 0 {
				t.Fatalf("unexpected stderr: %s", &stderr)
			}
		})
	}
}

func TestInvalidCommands(t *testing.T) {
	for _, args := range [][]string{
		{"setup", "extra"},
		{"--unknown"},
		{"version", "extra"},
		{"doctor", "extra"},
		{"doctor", "--unknown"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			root := newRootCommand("test", func(context.Context) (string, error) {
				t.Fatal("invalid input must not invoke gh")
				return "", nil
			})
			var output bytes.Buffer
			root.SetOut(&output)
			root.SetErr(&output)
			root.SetArgs(args)
			if err := root.ExecuteContext(context.Background()); err == nil {
				t.Fatal("expected an error for unsupported input")
			}
			if output.Len() != 0 {
				t.Fatalf("error must be rendered once by the entry point, got %q", output.String())
			}
		})
	}
}
