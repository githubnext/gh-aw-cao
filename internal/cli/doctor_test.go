package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func TestDoctor(t *testing.T) {
	for _, jsonOutput := range []bool{false, true} {
		t.Run(map[bool]string{false: "text", true: "json"}[jsonOutput], func(t *testing.T) {
			t.Chdir(t.TempDir())
			content := `{"version":1,"gh-aw-version":"v0.92.0","control-plane":{"campaigns":{}}}`
			writeTestFile(t, policyPath, content)
			type contextKey struct{}
			ctx := context.WithValue(context.Background(), contextKey{}, "marker")
			checkContext := func(ctx context.Context) {
				t.Helper()
				if ctx.Value(contextKey{}) != "marker" {
					t.Fatal("command context was not propagated")
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > doctorTimeout {
					t.Fatal("external check must have a bounded deadline")
				}
			}
			var calls [][]string
			root := newCommand("test", func(ctx context.Context) (string, error) {
				checkContext(ctx)
				return "gh version 2.80.0 (2025-09-23)\nhttps://example.com", nil
			}, func(ctx context.Context, args ...string) (string, string, error) {
				checkContext(ctx)
				calls = append(calls, args)
				if args[0] == "aw" {
					return "", "gh-aw version v0.92.0\n", nil
				}
				return "sensitive authentication output", "", nil
			}, func(*cobra.Command, []string) error {
				t.Fatal("doctor must never load the Node runtime")
				return nil
			})
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			args := []string{"doctor"}
			if jsonOutput {
				args = append(args, "--json")
			}
			root.SetArgs(args)
			if err := root.ExecuteContext(ctx); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(calls, [][]string{{"aw", "version"}, {"auth", "status"}}) {
				t.Fatalf("unexpected gh calls: %v", calls)
			}
			if stderr.Len() != 0 || strings.Contains(stdout.String(), "sensitive") {
				t.Fatalf("unexpected output: stdout=%q stderr=%q", &stdout, &stderr)
			}
			if jsonOutput {
				var report doctorReport
				if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
					t.Fatal(err)
				}
				if !report.OK || report.Command != "doctor" || len(report.Checks) != 5 {
					t.Fatalf("report = %+v", report)
				}
				for _, check := range report.Checks {
					if check.Status != "pass" {
						t.Fatalf("unexpected finding: %+v", check)
					}
				}
			} else if !strings.Contains(stdout.String(), "[PASS] github-cli: gh version 2.80.0") ||
				!strings.Contains(stdout.String(), "[PASS] gh-aw-version:") {
				t.Fatalf("unexpected text: %q", &stdout)
			}
			got, err := os.ReadFile(policyPath)
			if err != nil || string(got) != content {
				t.Fatalf("doctor modified policy: %q, %v", got, err)
			}
		})
	}
}

func TestDoctorFindings(t *testing.T) {
	tests := []struct {
		name, policy, ghVersion, awVersion, wantName, wantStatus string
		ghError, awError, authError                              bool
	}{
		{name: "missing gh", ghError: true, wantName: "github-cli", wantStatus: "fail"},
		{name: "bad gh version", ghVersion: "unexpected", wantName: "github-cli", wantStatus: "fail"},
		{name: "missing gh-aw", awError: true, wantName: "gh-aw", wantStatus: "fail"},
		{name: "empty gh-aw version", wantName: "gh-aw", wantStatus: "fail"},
		{name: "authentication failure", awVersion: "v0.92.0", authError: true, wantName: "authentication", wantStatus: "fail"},
		{name: "missing policy", awVersion: "v0.92.0", wantName: "policy", wantStatus: "fail"},
		{name: "invalid JSON", policy: "{", wantName: "policy", wantStatus: "fail"},
		{name: "null policy", policy: "null", wantName: "policy", wantStatus: "fail"},
		{name: "unsupported policy", policy: `{"version":2}`, wantName: "policy", wantStatus: "fail"},
		{name: "trailing JSON", policy: `{"version":1} {}`, wantName: "policy", wantStatus: "fail"},
		{name: "invalid control-plane", policy: `{"version":1,"control-plane":[]}`, wantName: "policy", wantStatus: "fail"},
		{name: "missing pin", policy: `{"version":1}`, wantName: "gh-aw-version", wantStatus: "fail"},
		{name: "non-string pin", policy: `{"version":1,"gh-aw-version":1}`, wantName: "gh-aw-version", wantStatus: "fail"},
		{name: "invalid pin", policy: `{"version":1,"gh-aw-version":"latest"}`, wantName: "gh-aw-version", wantStatus: "fail"},
		{name: "pin unavailable", policy: `{"version":1,"gh-aw-version":"v0.92.0"}`, awError: true, wantName: "gh-aw-version", wantStatus: "skip"},
		{name: "pin mismatch", policy: `{"version":1,"gh-aw-version":"v0.91.0"}`, awVersion: "v0.92.0", wantName: "gh-aw-version", wantStatus: "fail"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			if tt.policy != "" {
				writeTestFile(t, policyPath, tt.policy)
			}
			root := newCommand("test", func(context.Context) (string, error) {
				if tt.ghError {
					return "", errors.New("sensitive subprocess failure")
				}
				if tt.ghVersion != "" {
					return tt.ghVersion, nil
				}
				return "gh version 2.80.0", nil
			}, func(_ context.Context, args ...string) (string, string, error) {
				if tt.ghError || tt.ghVersion == "unexpected" {
					t.Fatal("dependent external checks must be skipped without gh")
				}
				if args[0] == "aw" && !tt.awError {
					return "gh-aw version " + tt.awVersion, "", nil
				}
				if args[0] == "auth" && !tt.authError {
					return "", "", nil
				}
				return "sensitive stdout", "sensitive stderr", errors.New("sensitive failure")
			}, nil)
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			root.SetArgs([]string{"doctor", "--json"})
			err := root.Execute()
			if err == nil {
				t.Fatal("expected failing diagnostic exit status")
			}
			if strings.Contains(stdout.String()+stderr.String()+err.Error(), "sensitive") {
				t.Fatal("diagnostics must not disclose raw external output")
			}
			var report doctorReport
			if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
				t.Fatal(err)
			}
			if report.OK || len(report.Checks) != 5 || stderr.Len() != 0 {
				t.Fatalf("unexpected report: %+v, stderr=%q", report, &stderr)
			}
			for _, check := range report.Checks {
				if check.Name == tt.wantName {
					if check.Status != tt.wantStatus {
						t.Fatalf("finding = %+v", check)
					}
					return
				}
			}
			t.Fatalf("missing finding %s: %+v", tt.wantName, report)
		})
	}
}

func TestDoctorCancellation(t *testing.T) {
	for _, cancelDuring := range []string{"before", "version", "aw", "auth"} {
		t.Run(cancelDuring, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cancelDuring == "before" {
				cancel()
			}
			root := newCommand("test", func(context.Context) (string, error) {
				if cancelDuring == "before" {
					t.Fatal("canceled command must not execute gh")
				}
				if cancelDuring == "version" {
					cancel()
				}
				return "gh version 2.80.0", nil
			}, func(_ context.Context, args ...string) (string, string, error) {
				if cancelDuring == args[0] {
					cancel()
				}
				return "gh-aw version v0.92.0", "", nil
			}, nil)
			var stdout bytes.Buffer
			root.SetOut(&stdout)
			root.SetArgs([]string{"doctor"})
			if err := root.ExecuteContext(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("error = %v, want cancellation", err)
			}
			if stdout.Len() != 0 {
				t.Fatalf("canceled diagnostic must not report success: %q", &stdout)
			}
		})
	}
}
