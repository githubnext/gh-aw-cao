package ghcli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestBoundedGHHelper(t *testing.T) {
	mode := os.Getenv("CAO_TEST_BOUNDED_GH")
	if mode == "" {
		return
	}
	switch mode {
	case "success":
		fmt.Fprint(os.Stdout, "test")
	case "overflow":
		fmt.Fprint(os.Stdout, strings.Repeat("x", 4096))
	case "failure":
		fmt.Fprint(os.Stderr, "credential-value-that-must-not-appear")
		os.Exit(1)
	case "cancel":
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func TestExecBounded(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"success", "overflow", "failure", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("CAO_TEST_BOUNDED_GH", mode)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if mode == "cancel" {
				cancel()
			}
			output, err := execBounded(ctx, binary, 4, "-test.run=^TestBoundedGHHelper$")
			if mode == "success" {
				if err != nil || output != "test" {
					t.Fatalf("output = %q, error = %v", output, err)
				}
				return
			}
			if err == nil || output != "" || strings.Contains(err.Error(), "credential-value-that-must-not-appear") {
				t.Fatalf("failure leaked output or passed: %q, %v", output, err)
			}
			if mode == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
		})
	}
}
