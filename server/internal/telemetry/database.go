package telemetry

import (
	"context"
	"errors"
	"net"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/semconv/v1.43.0/dbconv"
)

// NewDatabaseOperationDuration uses the semantic convention's instrument name,
// seconds unit, description and recommended histogram boundaries.
func NewDatabaseOperationDuration() (metric.Float64Histogram, error) {
	instrument, err := dbconv.NewClientOperationDuration(otel.Meter(tracerName),
		metric.WithExplicitBucketBoundaries(0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10))
	if err != nil {
		return nil, err
	}
	return instrument.Inst(), nil
}

// DatabaseErrorType deliberately excludes error messages and dynamic type names.
// Database clients may replace _OTHER with a validated protocol error code.
func DatabaseErrorType(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return "timeout"
	}
	return "_OTHER"
}
