//go:build authtests

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDoctorAuth(t *testing.T) {
	t.Chdir(filepath.Join("..", ".."))
	policy, err := os.ReadFile(policyPath)
	if err != nil {
		t.Fatal(err)
	}
	checks := []string{"github-cli", "gh-aw", "authentication", "policy", "gh-aw-version"}
	for _, format := range []string{"text", "json"} {
		t.Run(format, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			root := NewRootCommand("authtests")
			var stdout, stderr bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(&stderr)
			args := []string{"doctor"}
			if format == "json" {
				args = append(args, "--json")
			}
			root.SetArgs(args)
			if err := root.ExecuteContext(ctx); err != nil {
				t.Fatalf("authenticated doctor integration failed: %v\n%s", err, &stdout)
			}
			if stderr.Len() != 0 {
				t.Fatalf("unexpected diagnostic stderr: %s", &stderr)
			}
			if format == "json" {
				var report doctorReport
				if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
					t.Fatal(err)
				}
				if report.Command != "doctor" || !report.OK || len(report.Checks) != len(checks) {
					t.Fatalf("unexpected diagnostic report: %+v", report)
				}
				for index, check := range report.Checks {
					if check.Name != checks[index] || check.Status != "pass" || check.Remediation != "" {
						t.Fatalf("unexpected diagnostic check: %+v", check)
					}
				}
			} else {
				for _, name := range checks {
					if !strings.Contains(stdout.String(), "[PASS] "+name+":") {
						t.Fatalf("missing passing %s check: %s", name, &stdout)
					}
				}
			}
			after, err := os.ReadFile(policyPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(policy, after) {
				t.Fatal("doctor modified the control repository policy")
			}
		})
	}
}
