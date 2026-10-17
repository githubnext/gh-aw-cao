//go:build !windows

package hostedcli

import "errors"

func newWindowsSandboxHost(_ string) (windowsSandboxHost, error) {
	return windowsSandboxHost{}, errors.New("hosted CLI Windows Sandbox local development requires Windows 11 24H2 or later with the wsb CLI")
}
