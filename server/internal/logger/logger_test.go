package logger

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
)

func TestPatterns(t *testing.T) {
	original := debugEnv
	t.Cleanup(func() { debugEnv = original })

	tests := []struct {
		pattern   string
		namespace string
		enabled   bool
	}{
		{"", "cao:server", false},
		{"*", "cao:server", true},
		{"cao:*", "cao:server", true},
		{"*:server", "cao:server", true},
		{"cao:*,-cao:redis", "cao:redis", false},
		{"cao:*,-cao:redis", "cao:query", true},
	}
	for _, test := range tests {
		debugEnv = test.pattern
		if enabled := New(test.namespace).Enabled(); enabled != test.enabled {
			t.Errorf("New(%q) with DEBUG=%q enabled=%v, want %v", test.namespace, test.pattern, enabled, test.enabled)
		}
	}
}

func TestOutput(t *testing.T) {
	originalDebug := debugEnv
	originalColors := debugColors
	debugEnv = "*"
	debugColors = false
	t.Cleanup(func() {
		debugEnv = originalDebug
		debugColors = originalColors
	})

	output := captureStderr(t, func() {
		New("cao:test").Printf("processed %d items", 3)
	})
	if !strings.Contains(output, "cao:test processed 3 items +") {
		t.Fatalf("unexpected output: %q", output)
	}
}

func TestSlogAdapter(t *testing.T) {
	originalDebug := debugEnv
	originalColors := debugColors
	debugEnv = "*"
	debugColors = false
	t.Cleanup(func() {
		debugEnv = originalDebug
		debugColors = originalColors
	})

	handler := NewSlogHandler(New("cao:slog"))
	if !handler.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("enabled logger returned a disabled slog handler")
	}
	output := captureStderr(t, func() {
		NewSlogLoggerWithHandler(handler.logger).Info("request complete", "status", 200)
	})
	if !strings.Contains(output, "· request complete status=200") {
		t.Fatalf("unexpected slog output: %q", output)
	}
}

func captureStderr(t *testing.T, run func()) string {
	t.Helper()
	original := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = writer
	defer func() { os.Stderr = original }()

	run()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if _, err := output.ReadFrom(reader); err != nil {
		t.Fatal(err)
	}
	return output.String()
}
