package hostedcli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	maxExtensionBytes = 1 << 30
	maxExtensionDepth = 16
)

// copyExtensions snapshots the operator's gh extensions into a command's
// private data directory. Symbolic links are resolved and copied as content so
// the copy never refers back to the shared, writable source.
func copyExtensions(dataHome, destination string) error {
	if dataHome == "" {
		return nil
	}
	source := filepath.Join(dataHome, "gh", "extensions")
	if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	remaining := int64(maxExtensionBytes)
	return copyEntry(source, filepath.Join(destination, "gh", "extensions"), 0, &remaining)
}

func copyEntry(source, destination string, depth int, remaining *int64) error {
	if depth > maxExtensionDepth {
		return fmt.Errorf("gh extensions exceed depth %d", maxExtensionDepth)
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	switch {
	case info.IsDir():
		if err := os.MkdirAll(destination, 0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyEntry(filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name()), depth+1, remaining); err != nil {
				return err
			}
		}
		return nil
	case info.Mode().IsRegular():
		*remaining -= info.Size()
		if *remaining < 0 {
			return errors.New("gh extensions exceed the copy size limit")
		}
		return copyFile(source, destination, info.Mode().Perm()&0o755)
	default:
		return nil
	}
}

func copyFile(source, destination string, mode os.FileMode) error {
	input, err := os.Open(source) // #nosec G304 -- operator-configured extension directory
	if err != nil {
		return err
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode|0o600) // #nosec G304 -- per-command workspace
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}
