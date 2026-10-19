//go:build unix

package localops

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureProcess(command *exec.Cmd)          { command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func prepareExecution(_ *exec.Cmd)                {}
func resumeExecution(_ *exec.Cmd) (func(), error) { return func() {}, nil }
func killProcess(command *exec.Cmd) error {
	if command.Process == nil {
		return os.ErrProcessDone
	}
	err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}
