// Package sqlbuilder composes trusted SQL structure with quoted identifiers and
// bound values. Plain strings passed to Build are values, never SQL fragments.
package sqlbuilder

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Identifier string

// Fragment is SQL produced by the closed compiler or generated schema, not
// request text. Values and identifiers must use their separate builder paths.
type Fragment string

func QuoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

type Builder struct {
	text strings.Builder
	args []any
	err  error
}

func New(arguments ...any) *Builder {
	return &Builder{args: append([]any{}, arguments...)}
}

func (builder *Builder) Write(template string, parameters ...any) {
	if builder.err != nil {
		return
	}
	parts := strings.Split(template, "{}")
	if len(parts) != len(parameters)+1 {
		builder.err = errors.New("SQL builder placeholder count mismatch")
		return
	}
	builder.text.WriteString(parts[0])
	for index, parameter := range parameters {
		switch value := parameter.(type) {
		case Identifier:
			name := string(value)
			if name == "" || strings.ContainsRune(name, 0) || !utf8.ValidString(name) {
				builder.err = errors.New("invalid SQL identifier")
				return
			}
			builder.text.WriteString(QuoteIdentifier(name))
		case Fragment:
			if strings.ContainsRune(string(value), 0) {
				builder.err = errors.New("invalid compiler SQL fragment")
				return
			}
			builder.text.WriteString(string(value))
		default:
			builder.text.WriteString(builder.Bind(value))
		}
		builder.text.WriteString(parts[index+1])
	}
}

func (builder *Builder) Bind(value any) string {
	builder.args = append(builder.args, value)
	return "$" + strconv.Itoa(len(builder.args))
}

func (builder *Builder) Statement() (string, []any, error) {
	if builder.err != nil {
		return "", nil, builder.err
	}
	return builder.text.String(), append([]any{}, builder.args...), nil
}

func Build(template string, parameters ...any) (string, []any, error) {
	builder := New()
	builder.Write(template, parameters...)
	return builder.Statement()
}
