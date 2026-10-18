//go:build windows

package hostedcli

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsSandboxNativeWorkspaceACLPolicy(t *testing.T) {
	const sid = "S-1-5-21-1-2-3-1001"
	const other = "S-1-5-21-1-2-3-1002"
	const permissions = "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + sid + ")"
	for _, test := range []struct {
		name      string
		sddl      string
		directory bool
		workRoot  bool
		private   bool
	}{
		{name: "protected-root", sddl: "O:" + sid + "D:P" + permissions, directory: true, workRoot: true, private: true},
		{name: "inherited-child", sddl: "O:" + sid + "D:AI(A;OICIID;FA;;;" + sid + ")", directory: true, private: true},
		{name: "inherited-file", sddl: "O:" + sid + "D:AI(A;ID;FA;;;" + sid + ")", private: true},
		{name: "elevated-creator-owner", sddl: "O:BAD:P" + permissions, directory: true, workRoot: true, private: true},
		{name: "unprotected-root", sddl: "O:" + sid + "D:" + permissions, directory: true, workRoot: true},
		{name: "foreign-owner", sddl: "O:" + other + "D:P" + permissions, directory: true},
		{name: "everyone-readable-child", sddl: "O:" + sid + "D:P" + permissions + "(A;OICI;GR;;;WD)", directory: true},
		{name: "authenticated-users-readable-file", sddl: "O:" + sid + "D:P" + permissions + "(A;;GR;;;AU)"},
		{name: "null-dacl", sddl: "O:" + sid + "D:NO_ACCESS_CONTROL", directory: true},
		{name: "empty-dacl", sddl: "O:" + sid + "D:P", directory: true},
		{name: "non-inheritable-directory", sddl: "O:" + sid + "D:P(A;;FA;;;" + sid + ")", directory: true},
		{name: "inherit-only-owner", sddl: "O:" + sid + "D:P(A;OICIIO;FA;;;" + sid + ")", directory: true},
		{name: "unknown-inheritable-principal", sddl: "O:" + sid + "D:P" + permissions + "(A;OICIIO;GR;;;WD)", directory: true},
		{name: "no-owner-write-access", sddl: "O:" + sid + "D:P(A;OICI;GR;;;" + sid + ")", directory: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString(test.sddl)
			if err != nil {
				t.Fatal("invalid test security descriptor:", err)
			}
			if actual := windowsSandboxWorkspaceACL(sd, sid, test.directory, test.workRoot); actual != test.private {
				t.Fatalf("private ACL = %t, want %t", actual, test.private)
			}
		})
	}
	if windowsSandboxWorkspaceACL(nil, sid, true, true) {
		t.Fatal("missing Windows security descriptor was accepted")
	}
}
