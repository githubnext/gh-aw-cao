package server

import "go.opentelemetry.io/otel/attribute"

// queryTelemetryAttributes deliberately emits only numeric performance and
// structural aggregates. Query names, source names, fields, predicates,
// literals, route parameters, and result values never cross this boundary.
func queryTelemetryAttributes(input queryRequest, result queryResponse) []attribute.KeyValue {
	metrics := result.Metrics
	return []attribute.KeyValue{
		attribute.Int64("cao_dashboard.query.revision", result.Revision),
		attribute.Int("cao_dashboard.query.source_count", len(input.SourceNames)),
		attribute.Int("cao_dashboard.query.alias_count", len(input.Aliases)),
		attribute.Int64("cao_dashboard.query.duration_ms", metrics.DurationMS),
		attribute.Int("cao_dashboard.query.operations", metrics.Operations),
		attribute.Int("cao_dashboard.query.output_rows", metrics.OutputRows),
		attribute.Int("cao_dashboard.query.peak_working_rows", metrics.PeakWorkingRows),
		attribute.Int("cao_dashboard.query.retained_rows", metrics.RetainedRows),
		attribute.Int64("cao_dashboard.query.peak_working_bytes", metrics.PeakWorkingBytes),
		attribute.Int64("cao_dashboard.query.retained_bytes", metrics.RetainedBytes),
		attribute.Int("cao_dashboard.query.dependency_depth", metrics.DependencyDepth),
		attribute.Int("cao_dashboard.query.rate_limit_cost", metrics.RateLimitCost),
		attribute.Int("cao_dashboard.query.redis_commands", metrics.RedisCommands),
		attribute.Int("cao_dashboard.query.redis_rows", metrics.RedisRows),
		attribute.Int("cao_dashboard.query.structure.query_count", metrics.QueryCount),
		attribute.Int("cao_dashboard.query.structure.union_count", metrics.UnionCount),
		attribute.Int("cao_dashboard.query.structure.join_count", metrics.JoinCount),
		attribute.Int("cao_dashboard.query.structure.filter_count", metrics.FilterCount),
		attribute.Int("cao_dashboard.query.structure.compute_count", metrics.ComputeCount),
		attribute.Int("cao_dashboard.query.structure.aggregate_count", metrics.AggregateCount),
		attribute.Int("cao_dashboard.query.structure.aggregate_value_count", metrics.AggregateValueCount),
		attribute.Int("cao_dashboard.query.structure.temporal_series_count", metrics.TemporalSeriesCount),
		attribute.Int("cao_dashboard.query.structure.select_count", metrics.SelectCount),
		attribute.Int("cao_dashboard.query.structure.order_by_count", metrics.OrderByCount),
		attribute.Int("cao_dashboard.query.structure.limit_count", metrics.LimitCount),
		attribute.Int("cao_dashboard.query.pushed_down_count", len(metrics.PushedDown)),
		attribute.Int("cao_dashboard.query.fallback_count", len(metrics.FallbackOperations)),
	}
}
