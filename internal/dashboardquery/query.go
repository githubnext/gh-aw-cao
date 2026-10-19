// Package dashboardquery evaluates Dashboard Language for local SQLite
// consumers. Hosted PostgreSQL execution remains independently SQL-backed.
package dashboardquery

import (
	"context"
	"time"
)

// Execute evaluates one declarative definition with bounded, cancelable work.
// The loader owns source authorization and dependency resolution.
func Execute(ctx context.Context, definition map[string]any, load func(string) ([]map[string]any, error)) ([]map[string]any, error) {
	return executeNativeQuery(ctx, definition, load)
}

// Evaluator shares one deadline and operation budget across a dependency DAG.
// Intermediate results may reach the input-row budget; callers bound wire pages.
type Evaluator struct{ budget *engineBudget }

func NewEvaluator(ctx context.Context) *Evaluator {
	return &Evaluator{budget: &engineBudget{
		ctx: ctx, deadline: time.Now().Add(60 * time.Second), outputRows: engineMaxInputRows,
	}}
}

func (e *Evaluator) Execute(definition map[string]any, load func(string) ([]map[string]any, error)) ([]map[string]any, error) {
	return executeWithBudget(definition, load, e.budget)
}

func (e *Evaluator) Operations() int64 { return e.budget.operations }

// String preserves Dashboard Language's JavaScript-compatible scalar spelling.
func String(value any) string { return engineJSString(value) }

// ParseDate parses the date vocabulary used by Dashboard Language.
func ParseDate(value any) (float64, bool) { return engineParseDate(value) }
