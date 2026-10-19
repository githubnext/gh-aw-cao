//go:build unix

package localops

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func privateMetadata(_ string, info os.FileInfo, directory bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() || !directory && stat.Nlink != 1 {
		return errors.New("queue paths must be owned by the current user and files must have exactly one link")
	}
	return nil
}
func privateDirectoryPermissions(path string, info os.FileInfo) error {
	if info.Mode().Perm()&0077 == 0 {
		return nil
	}
	if filepath.Base(path) != ".cao" {
		return errors.New("queue directory must be owner-only")
	}
	return os.Chmod(path, 0700) // #nosec G302 -- verified owner-only directory needs traversal permission.
}
