package cli

import "fmt"

// ExitError carries a command status whose diagnostic has already been written.
type ExitError struct {
	Code int
}

func (e *ExitError) Error() string {
	return fmt.Sprintf("CAO command exited with status %d", e.Code)
}

// nativeErrorf preserves the existing CLI's user-facing diagnostic contract.
func nativeErrorf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}
