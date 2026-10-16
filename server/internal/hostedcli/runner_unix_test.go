//go:build !windows

package hostedcli

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestExecRunnerUsesOnlyGivenEnvironment(t *testing.T) {
	var mutex sync.Mutex
	var output strings.Builder
	code, err := ExecRunner{}.Run(context.Background(), Process{
		Program: "/bin/sh", Args: []string{"-c", "echo \"$ONLY\" \"${HOME:-unset}\"; exit 3"},
		Env: []string{"ONLY=value"}, Dir: t.TempDir(),
	}, func(_ string, data []byte) {
		mutex.Lock()
		output.Write(data)
		mutex.Unlock()
	})
	if err != nil || code != 3 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if strings.TrimSpace(output.String()) != "value unset" {
		t.Fatalf("unexpected output %q", output.String())
	}
}

func TestExecRunnerKillsProcessGroupOnCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := ExecRunner{WaitDelay: time.Second}.Run(ctx, Process{
		Program: "/bin/sh", Args: []string{"-c", "sleep 30 & sleep 30"}, Dir: t.TempDir(),
	}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline error, got %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("process group was not killed promptly")
	}
}
