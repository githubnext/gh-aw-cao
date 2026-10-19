package queryengine

import "context"

// Validate rejects unsupported or malformed Dashboard Language vocabulary.
func Validate(definition map[string]any) error { return engineValidate(definition) }

// JSString preserves the canonical JavaScript scalar serialization contract.
func JSString(value any) string { return engineJSString(value) }

// ParseDate returns milliseconds since the Unix epoch using the evaluator's
// JavaScript-compatible date parsing rules.
func ParseDate(value string) (float64, bool) { return engineParseDate(value) }

func executeNativeQuery(ctx context.Context, definition map[string]any, load func(string) ([]map[string]any, error)) ([]map[string]any, error) {
	return Execute(ctx, definition, load)
}
