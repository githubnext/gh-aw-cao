package cli

import (
	"context"

	"github.com/githubnext/gh-aw-cao/dashboard/queryengine"
)

type NativeQueryUnavailableError = queryengine.NativeQueryUnavailableError
type NativeQueryCancelledError = queryengine.NativeQueryCancelledError

func executeNativeQuery(ctx context.Context, definition map[string]any, load func(string) ([]map[string]any, error)) ([]map[string]any, error) {
	return queryengine.Execute(ctx, definition, load)
}

func engineJSString(value any) string              { return queryengine.JSString(value) }
func engineParseDate(value string) (float64, bool) { return queryengine.ParseDate(value) }
