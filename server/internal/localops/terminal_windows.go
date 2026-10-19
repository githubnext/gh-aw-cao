//go:build windows

package localops

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func executeTerminal(ctx context.Context, command *exec.Cmd, output func(string, string) error) (map[string]any, error) {
	input, inputWriter, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer func() { _ = input.Close(); _ = inputWriter.Close() }()
	reader, terminalOutput, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close(); _ = terminalOutput.Close() }()
	var console windows.Handle
	if err = windows.CreatePseudoConsole(windows.Coord{X: 80, Y: 24}, windows.Handle(input.Fd()), windows.Handle(terminalOutput.Fd()), 0, &console); err != nil {
		return nil, errors.New("native Windows ConPTY execution requires Windows 10 version 1809 or later")
	}
	defer func() {
		if console != 0 {
			windows.ClosePseudoConsole(console)
		}
	}()
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attributes.Delete()
	// The ConPTY attribute is the opaque HPCON value itself, not its address.
	update := windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")
	result, _, callErr := update.Call(uintptr(unsafe.Pointer(attributes.List())), 0, windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(console), unsafe.Sizeof(console), 0, 0) // #nosec G103 -- validated native attribute-list and opaque ConPTY handles; no user-controlled pointer.
	if result == 0 {
		return nil, callErr
	}
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	application, err := windows.UTF16PtrFromString(command.Path)
	if err != nil {
		return nil, err
	}
	arguments := make([]string, len(command.Args))
	for index, argument := range command.Args {
		arguments[index] = syscall.EscapeArg(argument)
	}
	line, err := windows.UTF16PtrFromString(strings.Join(arguments, " "))
	if err != nil {
		return nil, err
	}
	directory, err := windows.UTF16PtrFromString(command.Dir)
	if err != nil {
		return nil, err
	}
	environment := append([]string{}, command.Env...)
	sort.Slice(environment, func(left, right int) bool {
		return strings.ToUpper(environment[left]) < strings.ToUpper(environment[right])
	})
	block := utf16.Encode([]rune(strings.Join(environment, "\x00") + "\x00\x00"))
	var process windows.ProcessInformation
	if err = windows.CreateProcess(application, line, nil, nil, false, windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_SUSPENDED, &block[0], directory, &startup.StartupInfo, &process); err != nil {
		return nil, errors.New("could not start the CLI action terminal")
	}
	runtime.KeepAlive(block)
	defer func() { _ = windows.CloseHandle(process.Process); _ = windows.CloseHandle(process.Thread) }()
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		_ = windows.TerminateProcess(process.Process, 1)
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(job) }()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil { // #nosec G103 -- Win32 receives only the fixed, correctly sized job-limit structure.
		_ = windows.TerminateProcess(process.Process, 1)
		return nil, err
	}
	if err = windows.AssignProcessToJobObject(job, process.Process); err != nil {
		_ = windows.TerminateProcess(process.Process, 1)
		return nil, err
	}
	aborted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(aborted); _ = windows.TerminateJobObject(job, 1) })
	defer func() {
		if !stop() {
			<-aborted
		}
	}()
	if _, err = windows.ResumeThread(process.Thread); err != nil {
		return nil, err
	}
	// ConPTY retains its keyboard pipe, but the host never exposes or writes it.
	_ = terminalOutput.Close()
	type outcome struct {
		code uint32
		err  error
	}
	done := make(chan outcome, 1)
	ownedConsole := console
	console = 0
	go func() {
		_, waitErr := windows.WaitForSingleObject(process.Process, windows.INFINITE)
		var code uint32
		if waitErr == nil {
			waitErr = windows.GetExitCodeProcess(process.Process, &code)
		}
		_ = windows.TerminateJobObject(job, code)
		windows.ClosePseudoConsole(ownedConsole)
		done <- outcome{code, waitErr}
	}()
	var outputErr error
	buffer := make([]byte, 8<<10)
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 && outputErr == nil && output != nil {
			outputErr = output("stdout", string(buffer[:n]))
			if outputErr != nil {
				_ = windows.TerminateJobObject(job, 1)
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, windows.ERROR_BROKEN_PIPE) {
				outputErr = errors.New("the CLI action terminal output is unavailable")
				_ = windows.TerminateJobObject(job, 1)
			}
			break
		}
	}
	finished := <-done
	value := map[string]any{"ok": finished.err == nil && finished.code == 0 && outputErr == nil && ctx.Err() == nil, "exitCode": int64(finished.code)}
	if value["ok"] != true {
		value["error"] = "The CLI action did not complete successfully."
	}
	if ctx.Err() != nil {
		return value, ctx.Err()
	}
	if outputErr != nil {
		return value, errors.New("the CLI action output could not be persisted")
	}
	return value, finished.err
}
