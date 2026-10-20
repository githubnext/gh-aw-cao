package admission

import (
	"context"
	"errors"

	"go.opentelemetry.io/otel/codes"

	"github.com/githubnext/gh-cao/server/internal/telemetry"
)

// Keep identities, allowances, denial reasons and raw dependency errors outside
// telemetry. Only fixed operation names and generic availability cross here.
func observeOperation[T any](ctx context.Context, name string, operation func(context.Context) (T, error)) (T, error) {
	ctx, span := telemetry.Tracer().Start(ctx, name)
	defer span.End()
	result, err := operation(ctx)
	if err != nil && !errors.Is(err, ErrDenied) {
		span.SetStatus(codes.Error, "admission dependency unavailable")
	}
	return result, err
}
