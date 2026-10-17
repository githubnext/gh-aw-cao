package cli

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestCommands(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"root help", nil, "command parity is future work"},
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
		{"setup"},
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

func TestDoctor(t *testing.T) {
	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "marker")
	root := newRootCommand("test", func(got context.Context) (string, error) {
		if got.Value(contextKey{}) != "marker" {
			t.Fatal("command context was not propagated")
		}
		return "gh version test", nil
	})
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetArgs([]string{"doctor"})
	if err := root.ExecuteContext(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "gh version test\n") ||
		!strings.Contains(output.String(), "CAO policy were not checked") {
		t.Fatalf("unexpected diagnostic: %q", output.String())
	}
}

func TestDoctorFailure(t *testing.T) {
	want := errors.New("gh unavailable")
	root := newRootCommand("test", func(context.Context) (string, error) {
		return "", want
	})
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs([]string{"doctor"})
	if err := root.ExecuteContext(context.Background()); !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
	if output.Len() != 0 {
		t.Fatalf("failed diagnostic must not report success: %q", output.String())
	}
}
