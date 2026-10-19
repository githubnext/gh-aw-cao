package localops

import (
	"context"
	"time"
)

func (q *queue) sources(ctx context.Context, payload map[string]any) (any, error) {
	value, err := q.list(ctx, payload)
	if err != nil {
		return nil, err
	}
	list := value.(map[string]any)
	rows := list["commands"].([]any)
	for _, row := range rows {
		command := mapping(row)
		for _, field := range []string{"createdAt", "startedAt", "completedAt"} {
			if number, ok := command[field].(int64); ok {
				command[field] = time.UnixMilli(number).UTC().Format(time.RFC3339Nano)
			}
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	source := func(name string, rows []any) map[string]any {
		availability := "available"
		if len(rows) == 0 {
			availability = "empty"
		}
		return map[string]any{"source": name, "rows": rows, "metadata": map[string]any{"source-id": name, "source-kind": "runtime-command-queue", "as-of": now, "retrieved-at": now, "availability": availability, "completeness": "complete", "freshness": "fresh"}}
	}
	statuses := []any{}
	for _, status := range []string{"queued", "running", "completed", "failed", "canceled", "timed-out"} {
		statuses = append(statuses, map[string]any{"status": status})
	}
	reason := list["pausedReason"]
	if reason == nil {
		reason = ""
	}
	commands := source("cli-commands", rows)
	mapping(commands["metadata"])["total-row-count"] = list["total"]
	return map[string]any{
		"cli-commands":         commands,
		"cli-command-summary":  source("cli-command-summary", []any{map[string]any{"running": list["running"], "total": list["total"], "paused-reason": reason, "revision": list["revision"]}}),
		"cli-command-statuses": source("cli-command-statuses", statuses),
	}, nil
}
