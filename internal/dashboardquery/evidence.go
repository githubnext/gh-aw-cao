package dashboardquery

import (
	"errors"
	"strings"
	"time"
)

// OperationalValueEvidenceMetadata preserves evidence clocks without promoting
// incomplete acquisition or old captures to complete/fresh observations.
func OperationalValueEvidenceMetadata(packets []map[string]any) (map[string]any, error) {
	result := map[string]any{"completeness": "unknown", "freshness": "unknown"}
	for logical, field := range map[string]string{"as-of": "windowEnd", "retrieved-at": "observedAt"} {
		var earliest time.Time
		for _, packet := range packets {
			text, _ := packet[field].(string)
			instant, err := time.Parse(time.RFC3339Nano, text)
			if err != nil {
				return nil, errors.New("invalid operational value evidence clock")
			}
			if earliest.IsZero() || instant.Before(earliest) {
				earliest, result[logical] = instant, text
			}
		}
	}
	return result, nil
}

// OperationalValueEvidenceRows only projects acquired facts. Report computation
// belongs to the declarative query plan, never the storage adapter.
func OperationalValueEvidenceRows(packets []map[string]any) ([]map[string]any, error) {
	result := []map[string]any{}
	for _, packet := range packets {
		repository, ok := packet["repository"].(string)
		parts := strings.Split(repository, "/")
		facts, valid := packet["facts"].([]any)
		if !ok || len(parts) != 2 || !valid || len(facts) == 0 || len(facts) > 20000 {
			return nil, errors.New("invalid operational value evidence packet")
		}
		for _, item := range facts {
			fact, ok := item.(map[string]any)
			if !ok {
				return nil, errors.New("invalid operational value evidence fact")
			}
			row := map[string]any{
				"report-id": packet["id"], "organization": parts[0], "repository": parts[1],
				"workflow": packet["workflow"], "observed-at": packet["observedAt"],
				"workflow-path": packet["sourcePath"],
				"window-start":  packet["windowStart"], "window-end": packet["windowEnd"],
				"contract-digest": packet["contractDigest"],
			}
			for key, value := range fact {
				row[key] = value
			}
			result = append(result, row)
		}
	}
	return result, nil
}
