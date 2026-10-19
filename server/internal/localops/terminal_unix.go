//go:build unix

package localops

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

func executeTerminal(ctx context.Context, command *exec.Cmd, output func(string, string) error) (map[string]any, error) {
	// Stdout owns the controlling terminal while stdin remains /dev/null.
	// The host exposes no terminal input, resize, or escape-response channel.
	input, err := os.Open(os.DevNull)
	if err != nil {
		return nil, errors.New("read-only terminal input is unavailable")
	}
	command.Stdin = input
	terminal, err := pty.StartWithAttrs(command, &pty.Winsize{Cols: 80, Rows: 24}, &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 1})
	_ = input.Close()
	if err != nil {
		return nil, errors.New("could not start the CLI action terminal")
	}
	defer func() { _ = terminal.Close() }()
	wait := make(chan error, 1)
	go func() { err := command.Wait(); _ = killProcess(command); wait <- err }()
	var outputErr error
	buffer := make([]byte, 8<<10)
	for {
		n, readErr := terminal.Read(buffer)
		if n > 0 && outputErr == nil && output != nil {
			outputErr = output("stdout", string(buffer[:n]))
			if outputErr != nil {
				_ = killProcess(command)
			}
		}
		if readErr != nil {
			// Linux PTYs report EIO, while BSD PTYs report EOF on slave exit.
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, syscall.EIO) {
				outputErr = errors.New("the CLI action terminal output is unavailable")
				_ = killProcess(command)
			}
			break
		}
	}
	return commandResult(ctx, command, <-wait, outputErr)
}
