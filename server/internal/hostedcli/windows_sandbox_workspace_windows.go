//go:build windows

package hostedcli

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CAO_HOSTED_CLI_WORK_ROOT must be pre-provisioned with a protected,
// inheritable private DACL. One supported SDDL, with <SID> replaced by the
// executor account's SID, is:
//
//	O:<SID>D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;<SID>)
//
// MkdirTemp/Mkdir(0700) do not establish that boundary on Windows. The adapter
// never repairs ACLs or changes ownership. Every existing workspace entry,
// including home/work/data, must already have a private DACL. Inherited
// child DACLs are accepted; the work-root DACL itself must be protected.
func windowsSandboxPrivateWorkspace(ctx context.Context, workspace, sid string) (func(), error) {
	invalid := errors.New("hosted CLI Windows Sandbox requires a pre-provisioned protected private CAO_HOSTED_CLI_WORK_ROOT and a private, non-reparse workspace tree")
	if workspace == "" {
		return nil, invalid
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil || strings.HasPrefix(workspace, `\\`) {
		return nil, invalid
	}
	workRoot := filepath.Dir(workspace)
	if workRoot == workspace {
		return nil, invalid
	}
	var ancestors []string
	for directory := workspace; ; directory = filepath.Dir(directory) {
		ancestors = append(ancestors, directory)
		if filepath.Dir(directory) == directory {
			break
		}
	}
	slices.Reverse(ancestors)
	handles := make([]windows.Handle, 0, len(ancestors))
	release := func() {
		for index := len(handles) - 1; index >= 0; index-- {
			_ = windows.CloseHandle(handles[index])
		}
	}
	ready := false
	defer func() {
		if !ready {
			release()
		}
	}()
	// Pin the path chain without FILE_SHARE_DELETE until staging/VM creation
	// completes. A permissive ancestor must not permit a rename/reparse swap
	// between checking the private work root and resolving the mapping path.
	for _, directory := range ancestors {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		private := directory == workRoot || directory == workspace
		handle, isDirectory, err := windowsSandboxOpenWorkspaceEntry(directory, private)
		if err != nil {
			return nil, invalid
		}
		handles = append(handles, handle)
		if !isDirectory {
			return nil, invalid
		}
		if private {
			sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT,
				windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
			if err != nil || !windowsSandboxWorkspaceACL(sd, sid, true, directory == workRoot) {
				return nil, invalid
			}
		}
	}
	required := map[string]bool{"home": false, "work": false, "data": false}
	err = filepath.WalkDir(workspace, func(path string, _ fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return invalid
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		handle, directory, err := windowsSandboxOpenWorkspaceEntry(path, true)
		if err != nil {
			return invalid
		}
		defer func() { _ = windows.CloseHandle(handle) }()
		sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT,
			windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil || !windowsSandboxWorkspaceACL(sd, sid, directory, false) {
			return invalid
		}
		relative, err := filepath.Rel(workspace, path)
		if err != nil {
			return invalid
		}
		if _, expected := required[strings.ToLower(relative)]; expected {
			if !directory {
				return invalid
			}
			required[strings.ToLower(relative)] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, present := range required {
		if !present {
			return nil, invalid
		}
	}
	ready = true
	return release, nil
}

func windowsSandboxOpenWorkspaceEntry(path string, security bool) (windows.Handle, bool, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, false, err
	}
	access := uint32(windows.FILE_READ_ATTRIBUTES)
	if security {
		access |= windows.READ_CONTROL
	}
	handle, err := windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, false, err
	}
	var info windows.ByHandleFileInformation
	err = windows.GetFileInformationByHandle(handle, &info)
	if err != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(handle)
		return 0, false, errors.New("hosted CLI Windows Sandbox workspace entry is unavailable or a reparse point")
	}
	return handle, info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0, nil
}

func windowsSandboxWorkspaceACL(sd *windows.SECURITY_DESCRIPTOR, sid string, directory, protected bool) bool {
	const fileAllAccess windows.ACCESS_MASK = 0x001f01ff // FILE_ALL_ACCESS from WinNT.h.
	if sd == nil || !sd.IsValid() {
		return false
	}
	trusted := map[string]bool{sid: true, "S-1-5-18": true, "S-1-5-32-544": true}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !trusted[owner.String()] {
		return false
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PRESENT == 0 || (protected && control&windows.SE_DACL_PROTECTED == 0) {
		return false
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount == 0 {
		return false
	}
	currentFull, inheritableFull := false, false
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(dacl, index, &ace) != nil || ace == nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return false
		}
		const supportedFlags = windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE | windows.INHERITED_ACE
		if ace.Header.AceFlags & ^uint8(supportedFlags) != 0 {
			return false
		}
		// #nosec G103 -- GetAce returned a validated ACCESS_ALLOWED_ACE; SidStart is the documented variable SID field.
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !principal.IsValid() || !trusted[principal.String()] {
			return false
		}
		if principal.String() == sid && (ace.Mask&windows.GENERIC_ALL != 0 || ace.Mask&fileAllAccess == fileAllAccess) {
			currentFull = true
			if ace.Header.AceFlags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) == windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE {
				inheritableFull = true
			}
		}
	}
	return currentFull && (!directory || inheritableFull)
}
