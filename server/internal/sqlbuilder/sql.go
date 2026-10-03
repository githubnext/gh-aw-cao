// Package sqlbuilder composes trusted SQL structure with quoted identifiers and
// bound values. Plain strings passed to Build are values, never SQL fragments.
package sqlbuilder

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var sqlbuilderLog = logger.New("cao:sqlbuilder")

type Identifier string

// Fragment is SQL produced by the closed compiler or generated schema, not
// request text. Values and identifiers must use their separate builder paths.
type Fragment string

func QuoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// rejectionStage identifies which structural precondition a Builder failed,
// so a malformed call site is diagnosable without logging the SQL template,
// identifier, or fragment text that triggered it.
type rejectionStage string

const (
	rejectionStageNone             rejectionStage = "none"
	rejectionStagePlaceholderCount rejectionStage = "placeholder-count"
	rejectionStageIdentifier       rejectionStage = "identifier"
	rejectionStageFragment         rejectionStage = "fragment"
)

// validateIdentifier reports whether name is safe to quote as a SQL
// identifier. It is a pure function extracted from Write so this precondition
// is independently testable without constructing a Builder.
func validateIdentifier(name string) error {
	if name == "" || strings.ContainsRune(name, 0) || !utf8.ValidString(name) {
		return errors.New("invalid SQL identifier")
	}
	return nil
}

// validateFragment reports whether a compiler-produced SQL fragment is safe
// to splice verbatim. It is a pure function extracted from Write so this
// precondition is independently testable without constructing a Builder.
func validateFragment(fragment string) error {
	if strings.ContainsRune(fragment, 0) {
		return errors.New("invalid compiler SQL fragment")
	}
	return nil
}

type Builder struct {
	text  strings.Builder
	args  []any
	err   error
	stage rejectionStage
}

func New(arguments ...any) *Builder {
	return &Builder{args: append([]any{}, arguments...), stage: rejectionStageNone}
}

func (builder *Builder) Write(template string, parameters ...any) {
	if builder.err != nil {
		return
	}
	parts := strings.Split(template, "{}")
	if len(parts) != len(parameters)+1 {
		builder.err = errors.New("SQL builder placeholder count mismatch")
		builder.stage = rejectionStagePlaceholderCount
		return
	}
	builder.text.WriteString(parts[0])
	for index, parameter := range parameters {
		switch value := parameter.(type) {
		case Identifier:
			if err := validateIdentifier(string(value)); err != nil {
				builder.err = err
				builder.stage = rejectionStageIdentifier
				return
			}
			builder.text.WriteString(QuoteIdentifier(string(value)))
		case Fragment:
			if err := validateFragment(string(value)); err != nil {
				builder.err = err
				builder.stage = rejectionStageFragment
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
		sqlbuilderLog.Printf("SQL builder rejected statement stage=%s", builder.stage)
		return "", nil, builder.err
	}
	return builder.text.String(), append([]any{}, builder.args...), nil
}

func Build(template string, parameters ...any) (string, []any, error) {
	builder := New()
	builder.Write(template, parameters...)
	return builder.Statement()
}
