//go:build windows

package localops

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func processExited(pid int) bool {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid)) // #nosec G115 -- process ID came from the Windows child process.
	if err != nil {
		return errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	state, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && state == windows.WAIT_OBJECT_0
}

func TestWindowsNativeConPTYOutputAndCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "cmd.exe", "/d", "/c", "echo native-conpty")
	command.Dir = workspace(t)
	command.Env = terminalEnvironment(commandEnvironment())
	var output strings.Builder
	value, err := executeTerminal(ctx, command, func(stream, data string) error {
		if stream != "stdout" {
			t.Error(stream)
		}
		output.WriteString(data)
		return nil
	})
	if err != nil || value["ok"] != true || !strings.Contains(output.String(), "native-conpty") {
		t.Fatalf("%v %v %q", value, err, output.String())
	}
	ctx, stop := context.WithCancel(t.Context())
	command = exec.CommandContext(ctx, "cmd.exe", "/d", "/c", "echo started & ping -n 60 127.0.0.1 >NUL")
	command.Dir = workspace(t)
	command.Env = terminalEnvironment(commandEnvironment())
	started := time.Now()
	value, err = executeTerminal(ctx, command, func(_ string, data string) error {
		if strings.Contains(data, "started") {
			stop()
		}
		return nil
	})
	stop()
	if err == nil || value["ok"] == true || time.Since(started) > 10*time.Second {
		t.Fatalf("ConPTY cancellation failed: %v %v", value, err)
	}
}
func TestWindowsPrivateStorageRejectsHardlinksAndKeepsQueueFunctional(t *testing.T) {
	root := workspace(t)
	directory := filepath.Join(root, ".cao")
	if err := privateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(directory, "data")
	link := filepath.Join(directory, "linked")
	if err := os.WriteFile(original, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateFile(original); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(original, link); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateFile(link); err == nil {
		t.Fatal("multiply linked storage was accepted")
	}
	s := service(t, nil)
	value := enqueue(t, s, "complete")
	waitJob(t, s, value["id"], "completed")
}
