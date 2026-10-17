//go:build windows

package hostedcli

import (
	"context"
	"errors"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	windowsSandboxComputeCore = windows.NewLazySystemDLL("computecore.dll")
	windowsSandboxHCSCreate   = windowsSandboxComputeCore.NewProc("HcsCreateOperation")
	windowsSandboxHCSEnum     = windowsSandboxComputeCore.NewProc("HcsEnumerateComputeSystems")
	windowsSandboxHCSWait     = windowsSandboxComputeCore.NewProc("HcsWaitForOperationResult")
	windowsSandboxHCSClose    = windowsSandboxComputeCore.NewProc("HcsCloseOperation")
	windowsSandboxLocalSize   = windows.NewLazySystemDLL("kernel32.dll").NewProc("LocalSize")
)

// HCS_E_ACCESS_DENIED documents access for administrators or members of Hyper-V
// Administrators. Require one of those effective privileges explicitly so a
// less-privileged caller cannot mistake a restricted view for global absence.
// This adapter never elevates, changes group membership, or adjusts HCS ACLs.
func windowsSandboxRequireHCS() error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		group, err := windows.CreateWellKnownSid(windows.WinBuiltinHyperVAdminsSid)
		if err != nil {
			return errors.New("hosted CLI Windows Sandbox cannot verify HCS inventory privileges")
		}
		member, err := windows.Token(0).IsMember(group)
		if err != nil || !member {
			return errors.New("hosted CLI Windows Sandbox requires an elevated administrator or effective Hyper-V Administrators membership for global HCS inventory")
		}
	}
	for _, proc := range []*windows.LazyProc{
		windowsSandboxHCSCreate, windowsSandboxHCSEnum, windowsSandboxHCSWait,
		windowsSandboxHCSClose, windowsSandboxLocalSize,
	} {
		if err := proc.Find(); err != nil {
			return errors.New("hosted CLI Windows Sandbox requires the ComputeCore HCS inventory APIs")
		}
	}
	return nil
}

// This binds only operation management and enumeration. No HCS compute-system
// open, stop, terminate, or ID-translation API is used. Microsoft documents
// the v2 asynchronous API in ComputeCore.dll, not the legacy vmcompute.dll ABI.
func windowsSandboxHCSInventory(ctx context.Context) ([]byte, error) {
	if err := windowsSandboxRequireHCS(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	operation, _, _ := windowsSandboxHCSCreate.Call(0, 0)
	if operation == 0 {
		return nil, errors.New("hosted CLI Windows Sandbox HCS enumeration operation could not be created")
	}
	defer func() { _, _, _ = windowsSandboxHCSClose.Call(operation) }()
	// NULL query is the documented "enumerate all compute systems" sample.
	// In particular there is no owner/user filter or inferred wsb ID mapping.
	result, _, _ := windowsSandboxHCSEnum.Call(0, operation)
	if result&0xffffffff != 0 {
		return nil, errors.New("hosted CLI Windows Sandbox HCS enumeration could not start")
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var document *uint16
		// #nosec G103 -- Documented synchronous PWSTR* out parameter; HCS allocates the returned string.
		result, _, _ := windowsSandboxHCSWait.Call(operation, 50, uintptr(unsafe.Pointer(&document)))
		if result&0xffffffff == uintptr(windows.HCS_E_OPERATION_TIMEOUT) {
			windowsSandboxHCSFree(document)
			continue
		}
		if result&0xffffffff != 0 {
			windowsSandboxHCSFree(document)
			return nil, errors.New("hosted CLI Windows Sandbox HCS enumeration failed")
		}
		defer windowsSandboxHCSFree(document)
		return windowsSandboxHCSResult(document)
	}
}

func windowsSandboxHCSFree(document *uint16) {
	if document != nil {
		// #nosec G103 -- The HCS contract explicitly transfers this native allocation to LocalFree.
		_, _ = windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(document))))
	}
}

func windowsSandboxHCSResult(document *uint16) ([]byte, error) {
	invalid := errors.New("hosted CLI Windows Sandbox HCS result is missing, oversized, or malformed")
	if document == nil {
		return nil, invalid
	}
	// HcsWaitForOperationResult returns a LocalFree-owned UTF-16 string.
	// Bound against the actual allocation, rather than performing an
	// unbounded UTF16PtrToString read over other workloads' inventory.
	// #nosec G103 -- Query the allocation extent of the LocalFree-owned native result, not a Go pointer.
	size, _, _ := windowsSandboxLocalSize.Call(uintptr(unsafe.Pointer(document)))
	if size < 2 || size > 2*(windowsSandboxResponseMax+1) || size%2 != 0 {
		return nil, invalid
	}
	// #nosec G103 -- LocalSize verified the allocation extent, bounded size, and UTF-16 alignment above.
	chars := unsafe.Slice(document, size/2)
	for index, character := range chars {
		if character == 0 {
			data := []byte(windows.UTF16ToString(chars[:index]))
			if len(data) > windowsSandboxResponseMax {
				return nil, invalid
			}
			return data, nil
		}
	}
	return nil, invalid
}
