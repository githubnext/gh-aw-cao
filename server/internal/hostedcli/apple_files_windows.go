//go:build windows

package hostedcli

import "errors"

func appleReadPrivateFile(_, _ string, _ int64) ([]byte, error) {
	return nil, errors.New("the Apple container runtime files require macOS")
}
