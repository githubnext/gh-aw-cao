//go:build !windows

package operationalvalue

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var processTreeLog = logger.New("cao:operationalvalue:processtree")

func configureProcessTree(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// classifyProcessGroupKillError translates the raw error from killing a
// process group into the terminateProcessTree result: nil when the group was
// signaled, os.ErrProcessDone when it had already exited, or the original
// error for any other failure. It is a pure function extracted from
// terminateProcessTree so this translation is independently testable against
// real syscall errors without spawning a process group.
func classifyProcessGroupKillError(err error) error {
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

func terminateProcessTree(process *os.Process) error {
	if process == nil {
		return nil
	}
	err := classifyProcessGroupKillError(syscall.Kill(-process.Pid, syscall.SIGKILL))
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		processTreeLog.Printf("process group termination failed pid=%d", process.Pid)
	}
	return err
}
