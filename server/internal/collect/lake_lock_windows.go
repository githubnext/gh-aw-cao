package collect

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func tryLockEvidence(file *os.File) (bool, error) {
	// All writers lock the same byte; closing the handle releases the lock.
	err := windows.LockFileEx(windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}
