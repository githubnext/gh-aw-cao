// Package operator exposes native dashboard action execution without importing
// the dashboard HTTP server or its local serving lifecycle into gh-cao.
package operator

import (
	"context"

	"github.com/githubnext/gh-aw-cao/server/internal/localops"
)

func ParseCommand(command string) ([]string, error) { return localops.ParseCommand(command) }

func ExecuteCommand(ctx context.Context, workspace, ghExecutable, command, input string, output func(string, string)) (map[string]any, error) {
	return localops.ExecuteCommand(ctx, workspace, ghExecutable, command, input, output)
}
