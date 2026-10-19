//go:build windows

package localops

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var executionJobs = struct {
	sync.Mutex
	jobs map[*exec.Cmd]windows.Handle
}{jobs: map[*exec.Cmd]windows.Handle{}}

func configureProcess(_ *exec.Cmd) {}
func prepareExecution(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NEW_PROCESS_GROUP}
}
func resumeExecution(command *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	cleanup := func() {
		executionJobs.Lock()
		delete(executionJobs.jobs, command)
		_ = windows.CloseHandle(job)
		executionJobs.Unlock()
	}
	resumed := false
	defer func() {
		if !resumed {
			cleanup()
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil { // #nosec G103 -- Win32 receives only the fixed, correctly sized job-limit structure.
		return nil, err
	}
	pid := uint32(command.Process.Pid) // #nosec G115 -- os.Process.Pid originated from the Windows uint32 process ID.
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	if err = windows.AssignProcessToJobObject(job, handle); err != nil {
		return nil, err
	}
	executionJobs.Lock()
	executionJobs.jobs[command] = job
	executionJobs.Unlock()
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(snapshot) }()
	thread := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &thread); err == nil; err = windows.Thread32Next(snapshot, &thread) {
		if thread.OwnerProcessID != pid {
			continue
		}
		worker, openErr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, thread.ThreadID)
		if openErr != nil {
			return nil, openErr
		}
		_, resumeErr := windows.ResumeThread(worker)
		_ = windows.CloseHandle(worker)
		if resumeErr != nil {
			return nil, resumeErr
		}
		resumed = true
		return cleanup, nil
	}
	return nil, os.ErrProcessDone
}
func killProcess(command *exec.Cmd) error {
	if command.Process == nil {
		return os.ErrProcessDone
	}
	executionJobs.Lock()
	defer executionJobs.Unlock()
	if job := executionJobs.jobs[command]; job != 0 {
		return windows.TerminateJobObject(job, 1)
	}
	return command.Process.Kill()
}
