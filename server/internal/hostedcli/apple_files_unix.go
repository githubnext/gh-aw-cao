//go:build !windows

package hostedcli

import (
	"errors"
	"io"
	"os"
	"syscall"
)

func appleReadPrivateFile(directory, name string, limit int64) ([]byte, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("native runtime file is not a bounded regular file")
	}
	value, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(value)) > limit {
		return nil, errors.New("native runtime file could not be read within its limit")
	}
	return value, nil
}
