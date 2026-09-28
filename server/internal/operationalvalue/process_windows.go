//go:build windows

package operationalvalue

import (
	"os"
	"os/exec"
)

func configureProcessTree(_ *exec.Cmd) {}

func terminateProcessTree(process *os.Process) error {
	if process == nil {
		return nil
	}
	return process.Kill()
}
