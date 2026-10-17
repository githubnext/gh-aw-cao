//go:build !windows

package runtimecli

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"github.com/cli/go-gh/v2/pkg/term"
)

func configureProcess(cmd *exec.Cmd) {
	if file, ok := cmd.Stdin.(*os.File); ok && term.IsTerminal(file) {
		// Keep terminal readers in the foreground group so secure prompts can read.
		cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGINT)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}

func stopProcessTree(cmd *exec.Cmd) error {
	if cmd.Process != nil && cmd.SysProcAttr != nil && cmd.SysProcAttr.Setpgid {
		// Stop descendants that outlive the Node entry point on cancellation.
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	return nil
}
