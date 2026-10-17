package runtimecli

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"time"
)

func configureProcess(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return killWindowsTree(cmd.Process.Pid) }
}

func stopProcessTree(cmd *exec.Cmd) error {
	if cmd.Process != nil {
		return killWindowsTree(cmd.Process.Pid)
	}
	return nil
}

func killWindowsTree(pid int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 128 {
		return nil
	}
	return err
}
