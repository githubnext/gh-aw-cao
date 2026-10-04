package postgresx

import (
	"errors"
	"fmt"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func validateToolProjection(source string, row model.Row) error {
	if source != "$tools" && source != "$toolCounters" {
		return nil
	}
	strings := []string{"runId", "evidenceRevision"}
	numbers := []string{"eventCount"}
	switch source {
	case "$tools":
		strings = append(strings, "toolId", "source")
		numbers = append(numbers, "callCount", "outcomeCount", "successCount", "failedCount", "incompleteCount",
			"unknownOutcomeCount", "unmatchedCount", "ambiguousCount", "requestBytes", "requestBytesCount",
			"responseBytes", "responseBytesCount", "latencyCount")
	case "$toolCounters":
		strings = append(strings, "usageId")
		numbers = append(numbers, "requestBytes", "requestBytesCount", "responseBytes", "responseBytesCount")
	}
	for _, field := range strings {
		if value, ok := row[field].(string); !ok || value == "" {
			return fmt.Errorf("%s.%s is required by the fresh Tool aggregate contract", source, field)
		}
	}
	counts := map[string]int64{}
	for _, field := range numbers {
		bound, err := (entityColumn{kind: "numeric", sql: "BIGINT"}).bind(row[field])
		value, ok := bound.(int64)
		if err != nil || !ok || value < 0 || value > 9007199254740991 {
			return fmt.Errorf("%s.%s must be a nonnegative safe integer", source, field)
		}
		counts[field] = value
	}
	if counts["eventCount"] == 0 {
		return errors.New("tool facts must describe at least one observed event")
	}
	if source == "$tools" {
		if counts["callCount"]+counts["outcomeCount"] > counts["eventCount"] ||
			counts["successCount"]+counts["failedCount"]+counts["incompleteCount"]+counts["unknownOutcomeCount"] != counts["outcomeCount"] ||
			counts["requestBytesCount"] > counts["callCount"] || counts["responseBytesCount"] > counts["callCount"] ||
			counts["latencyCount"] > counts["callCount"] {
			return errors.New("tool aggregate counters do not preserve their declared grain")
		}
		if row["latencySum"] == nil {
			return errors.New("tool aggregate latency sum is required, with a separate known-value count")
		}
		for _, pair := range [][2]string{{"requestBytes", "requestBytesCount"}, {"responseBytes", "responseBytesCount"}} {
			if counts[pair[1]] == 0 && counts[pair[0]] != 0 {
				return errors.New("unknown Tool measurements cannot have nonzero sums")
			}
		}
	}
	return nil
}
