package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type dashboardProcess struct {
	PID      int    `json:"pid"`
	Port     int    `json:"port"`
	Identity string `json:"identity"`
	Command  string `json:"command"`
}

func dashboardProcessIdentity(ctx context.Context, pid int) (dashboardProcess, error) {
	read := func(field string) (string, error) {
		output, err := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(pid), "-o", field+"=").Output()
		return strings.TrimSpace(string(output)), err
	}
	start, err := read("lstart")
	if err != nil {
		return dashboardProcess{}, err
	}
	command, err := read("args")
	return dashboardProcess{PID: pid, Identity: start, Command: command}, err
}

func replaceDashboardProcess(ctx context.Context, workspace string, port int) (func() error, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	cwd, err = filepath.EvalSymlinks(cwd)
	if err != nil || cwd != workspace {
		return nil, errors.New("preview replacement requires running from the selected workspace")
	}
	path := filepath.Join(workspace, ".cao-dashboard-dev-server.json")
	content, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var previous dashboardProcess
	if err == nil {
		if err := json.Unmarshal(content, &previous); err != nil {
			return nil, errors.New("cannot replace preview: invalid workspace process record")
		}
	}
	if previous.Port == port && previous.PID > 0 && previous.PID != os.Getpid() {
		process, err := os.FindProcess(previous.PID)
		if err != nil {
			return nil, err
		}
		defer func() { _ = process.Release() }()
		if err := process.Signal(syscall.Signal(0)); err == nil {
			current, err := dashboardProcessIdentity(ctx, previous.PID)
			if err != nil || current.Identity == "" || current.Identity != previous.Identity || current.Command != previous.Command {
				return nil, errors.New("cannot replace preview: recorded process identity changed")
			}
			name, err := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(previous.PID), "-o", "comm=").Output()
			if err != nil || filepath.Base(strings.TrimSpace(string(name))) != "gh-cao" ||
				!strings.Contains(current.Command, " dashboard serve") {
				return nil, errors.New("cannot replace preview: process is not a native gh-cao dashboard")
			}
			directory, err := dashboardProcessDirectory(ctx, previous.PID)
			if err != nil || directory != workspace {
				return nil, errors.New("cannot replace preview: process does not belong to this workspace")
			}
			if err := process.Signal(syscall.SIGTERM); err != nil {
				return nil, err
			}
			for deadline := time.Now().Add(7 * time.Second); ; {
				if err := process.Signal(syscall.Signal(0)); errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
					break
				}
				if time.Now().After(deadline) {
					return nil, fmt.Errorf("previous dashboard process %d did not stop", previous.PID)
				}
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(50 * time.Millisecond):
				}
			}
		} else if !errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH) {
			return nil, err
		}
	}
	current, err := dashboardProcessIdentity(ctx, os.Getpid())
	if err != nil {
		return nil, err
	}
	current.Port = port
	content, err = json.Marshal(current)
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(workspace, ".cao-dashboard-process-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(file.Name()) }()
	if _, err := file.Write(append(content, '\n')); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return nil, err
	}

	return func() error {
		content, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		var recorded dashboardProcess
		if err := json.Unmarshal(content, &recorded); err != nil {
			return err
		}
		if recorded.PID == current.PID && recorded.Identity == current.Identity {
			return os.Remove(path)
		}
		return nil
	}, nil
}

func dashboardProcessDirectory(ctx context.Context, pid int) (string, error) {
	var directory string
	switch runtime.GOOS {
	case "linux":
		var err error
		directory, err = os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "cwd"))
		if err != nil {
			return "", err
		}
	case "darwin":
		output, err := exec.CommandContext(ctx, "/usr/sbin/lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
		if err != nil {
			return "", err
		}
		for _, line := range strings.Split(string(output), "\n") {
			if strings.HasPrefix(line, "n") {
				directory = strings.TrimPrefix(line, "n")
			}
		}
	default:
		return "", errors.New("safe preview replacement is unsupported on this platform")
	}
	if directory == "" {
		return "", errors.New("preview process workspace is unavailable")
	}
	return filepath.EvalSymlinks(directory)
}
