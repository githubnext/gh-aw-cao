package postgresx

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
	"github.com/githubnext/gh-cao/server/internal/model"
)

const conclusionSource = "conclusion-admission"

type compactSessionEvent struct {
	Type       string         `json:"type"`
	Data       map[string]any `json:"data"`
	Timestamp  any            `json:"timestamp"`
	Provenance map[string]any `json:"provenance"`
}

type compactUsage struct {
	fields model.Row
	key    string
	rank   int
}

type conclusionProjection struct {
	run          model.Row
	audits       []model.Row
	graders      []model.Row
	observations []model.Row
}

var conclusionTokenFields = map[string]string{
	"inputTokens": "inputTokens", "outputTokens": "outputTokens",
	"cacheReadInputTokens": "cacheReadTokens", "cacheCreationInputTokens": "cacheWriteTokens",
	"reasoningOutputTokens": "reasoningTokens", "totalTokens": "totalTokens",
}

func conclusionID(kind, coordinate string) string {
	return kind + ":" + conclusionSource + ":" + model.EncodeCoordinate(coordinate)
}

// The callback has already passed the compact-profile validator. This adapter
// projects only existing typed facts, never nested session JSON or API status.
func projectConclusion(identity admission.Identity, input admission.ConclusionRequest, run model.Row, at time.Time) (conclusionProjection, error) {
	projected := conclusionProjection{run: run}
	runID, _ := run["id"].(string)
	workflowID, _ := run["workflowId"].(string)
	c := input.SessionCompaction
	projected.audits = append(projected.audits, model.Row{
		"id": conclusionID("audit", runID+":coverage"), "runId": runID,
		"source": conclusionSource, "type": "session.collection", "observedAt": at,
		"name": identity.RunAttempt, "evidenceState": "partial",
		"totalEvents": c.IncludedEvents, "eventsTruncated": c.Truncated || c.ScanTruncated,
		"sourceSequence": 0, "summary": "compact-session/v1",
		"status":   map[bool]string{true: "truncated", false: "not-truncated"}[c.Truncated],
		"decision": map[bool]string{true: "scan-truncated", false: "scan-untruncated"}[c.ScanTruncated],
	})
	for n, entry := range []struct {
		name  string
		value any
	}{{"omitted_events", c.OmittedEvents}, {"oversized_lines", c.OversizedLines}} {
		projected.audits = append(projected.audits, model.Row{
			"id": conclusionID("audit", runID+":"+entry.name), "runId": runID,
			"source": conclusionSource, "type": "session.collection", "observedAt": at,
			"code": entry.name, "value": entry.value, "evidenceState": "partial", "sourceSequence": -n - 1,
		})
	}
	phases := map[string][]compactUsage{}
	for index, line := range strings.Split(strings.TrimSuffix(input.Session, "\n"), "\n") {
		if line == "" {
			continue
		}
		var event compactSessionEvent
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&event); err != nil {
			return conclusionProjection{}, fmt.Errorf("decode validated compact event: %w", err)
		}
		if !compactRunMatches(event.Data, identity) {
			continue
		}
		if event.Type == "grader.result" {
			if nested, ok := event.Data["run"].(map[string]any); ok &&
				(fmt.Sprint(nested["id"]) != identity.RunID || !compactAttemptMatches(nested["attempt"], identity.RunAttempt)) {
				continue
			}
		}
		audit := compactAudit(event, at)
		audit["id"], audit["runId"] = conclusionID("audit", fmt.Sprintf("%s:line:%d", runID, index+1)), runID
		audit["sourceSequence"] = index + 1
		projected.audits = append(projected.audits, audit)
		if event.Type == "workflow.info" {
			for source, target := range map[string]string{
				"engineId": "engineId", "agentVersion": "agentVersion", "cliVersion": "ghAwVersion",
				"awfVersion": "firewallVersion", "mcpgVersion": "gatewayVersion",
				"model": "modelId", "requestedModel": "requestedModel",
			} {
				copyCompactString(run, target, event.Data[source])
			}
			copyCompactString(run, "engineVersion", event.Data["agentVersion"])
			copyCompactString(run, "agentId", event.Data["engineId"])
			copyCompactString(run, "resolvedModel", event.Data["model"])
			if run["requestedModel"] == nil {
				copyCompactString(run, "requestedModel", event.Data["model"])
			}
		}
		if event.Type == "grader.result" {
			name, _ := event.Data["id"].(string)
			if strings.TrimSpace(name) != "" {
				graderID := "grader:gh-aw-logs:" + model.EncodeCoordinate(workflowID+":"+name)
				grader := model.Row{
					"id": graderID, "workflowId": workflowID, "name": name, "displayName": name, "sourceGraderId": name,
					"firstObservedAt": at, "lastObservedAt": at,
					"provenance": model.Row{"source": conclusionSource, "sourceId": audit["id"], "observedAt": at},
				}
				for _, field := range []string{"unit", "direction"} {
					copyCompactString(grader, field, event.Data[field])
				}
				copyCompactFinite(grader, "threshold", event.Data["threshold"])
				observation := model.Row{
					"id":    conclusionID("grader-observation", fmt.Sprintf("%s:%s:%d", runID, name, index+1)),
					"runId": runID, "graderId": graderID, "auditId": audit["id"],
					"provenance": model.Row{"source": conclusionSource, "sourceId": audit["id"], "observedAt": at},
				}
				if timestamp, exists := audit["timestamp"]; exists {
					observation["timestamp"] = timestamp
				}
				copyCompactFinite(observation, "value", event.Data["value"])
				if _, exists := observation["value"]; !exists {
					copyCompactFinite(observation, "value", event.Data["score"])
				}
				copyCompactString(observation, "status", event.Data["status"])
				if _, exists := observation["status"]; !exists {
					if passed, ok := event.Data["passed"].(bool); ok {
						observation["status"] = map[bool]string{true: "passed", false: "failed"}[passed]
					}
				}
				projected.graders = append(projected.graders, grader)
				projected.observations = append(projected.observations, observation)
			}
		}
		rank := map[string]int{"usage.report": 3, "firewall.token_usage": 2, "session.result": 1}[event.Type]
		if rank != 0 {
			phase, present := event.Provenance["phase"].(string)
			if !present {
				phase = "agent"
			}
			fields := model.Row{}
			for _, target := range conclusionTokenFields {
				if value, exists := audit[target]; exists {
					fields[target] = value
				}
			}
			for _, field := range []string{"aic", "totalAic"} {
				if value, exists := audit[field]; exists {
					fields[field] = value
				}
			}
			if len(fields) == 0 {
				continue
			}
			key := strconv.Itoa(index)
			if rank == 1 {
				key = "snapshot"
			}
			phases[phase] = append(phases[phase], compactUsage{fields: fields, key: key, rank: rank})
		}
	}
	compactRunUsage(run, phases)
	run["updatedAt"] = at
	run["runLink"] = "https://github.com/" + identity.Repository + "/actions/runs/" + identity.RunID
	return projected, nil
}

func compactAttemptMatches(value any, attempt string) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok {
		return text == attempt
	}
	if number, ok := compactNumber(value); ok && number > 0 && number <= 1<<53-1 && math.Trunc(number) == number {
		return strconv.FormatFloat(number, 'f', 0, 64) == attempt
	}
	return false
}

func compactRunMatches(data map[string]any, identity admission.Identity) bool {
	if value, exists := data["runId"]; exists && fmt.Sprint(value) != identity.RunID {
		return false
	}
	return compactAttemptMatches(data["runAttempt"], identity.RunAttempt)
}

func compactNumber(value any) (float64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Float64()
	return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
}

func copyCompactString(row model.Row, field string, value any) {
	if text, ok := value.(string); ok && text != "" {
		row[field] = text
	}
}

func copyCompactNumber(row model.Row, field string, value any, integer bool) {
	number, ok := compactNumber(value)
	if !ok || number < 0 {
		return
	}
	if integer {
		if number <= 1<<53-1 && math.Trunc(number) == number {
			row[field] = int64(number)
		}
	} else {
		row[field] = number
	}
}

func copyCompactFinite(row model.Row, field string, value any) {
	if number, ok := compactNumber(value); ok {
		row[field] = number
	}
}

func compactAudit(event compactSessionEvent, at time.Time) model.Row {
	data := event.Data
	row := model.Row{"source": "session", "type": event.Type, "observedAt": at, "evidenceState": "partial"}
	for _, field := range []string{"model", "provider", "status", "sourceEngine"} {
		copyCompactString(row, field, data[field])
	}
	for _, field := range []string{"component", "phase"} {
		copyCompactString(row, field, event.Provenance[field])
	}
	for _, entry := range []struct{ source, target string }{
		{"engineId", "sourceEngine"}, {"jobId", "name"},
		{"conclusion", "status"}, {"outcome", "status"}, {"result", "status"}, {"status", "status"},
	} {
		copyCompactString(row, entry.target, data[entry.source])
	}
	for _, field := range []string{"aic", "totalAic", "premiumRequests", "totalCostUsd", "durationMs", "threshold"} {
		copyCompactNumber(row, field, data[field], false)
	}
	copyCompactNumber(row, "turns", data["numTurns"], true)
	if number, ok := compactNumber(data["exitCode"]); ok && math.Abs(number) <= 1<<53-1 && math.Trunc(number) == number {
		row["exitCode"] = int64(number)
	}
	usage, _ := data["usage"].(map[string]any)
	for source, target := range conclusionTokenFields {
		copyCompactNumber(row, target, usage[source], true)
	}
	switch event.Type {
	case "session.format":
		copyCompactNumber(row, "value", data["version"], false)
	case "session.result":
		row["evidenceState"] = "snapshot"
	case "guardrail.daily_aic":
		copyCompactNumber(row, "value", data["total"], false)
		if exceeded, ok := data["exceeded"].(bool); ok {
			row["decision"] = map[bool]string{true: "exceeded", false: "under-budget"}[exceeded]
		}
	case "grader.result":
		copyCompactString(row, "name", data["id"])
		copyCompactFinite(row, "value", data["value"])
		if _, exists := row["value"]; !exists {
			copyCompactFinite(row, "value", data["score"])
		}
	}
	var instant time.Time
	switch timestamp := event.Timestamp.(type) {
	case string:
		instant, _ = time.Parse(time.RFC3339Nano, timestamp)
	case json.Number:
		if milliseconds, err := timestamp.Float64(); err == nil && math.Abs(milliseconds) <= 8640000000000000 {
			instant = time.UnixMilli(int64(milliseconds))
		}
	}
	if !instant.IsZero() && instant.Year() >= 1 && instant.Year() <= 9999 {
		row["timestamp"] = instant.UTC()
	}
	return row
}

// Mirrors sessionRunMetadata: choose the highest-ranked evidence independently
// per phase and dimension; snapshots and cumulative AIC are never added twice.
func compactRunUsage(run model.Row, phases map[string][]compactUsage) {
	names := make([]string, 0, len(phases))
	for name := range phases {
		names = append(names, name)
	}
	sort.Strings(names)
	invalid := map[string]bool{}
	for _, phase := range names {
		entries := phases[phase]
		latest := map[string]int{}
		for n, entry := range entries {
			latest[strconv.Itoa(entry.rank)+":"+entry.key] = n
		}
		retained := make([]compactUsage, 0, len(entries))
		for n, entry := range entries {
			if latest[strconv.Itoa(entry.rank)+":"+entry.key] == n {
				retained = append(retained, entry)
			}
		}
		entries = retained
		for _, field := range []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "aicTotal"} {
			if invalid[field] {
				continue
			}
			rank := 0
			for _, entry := range entries {
				_, exists := entry.fields[field]
				if field == "aicTotal" {
					exists = entry.fields["aic"] != nil || entry.fields["totalAic"] != nil
				}
				if exists && entry.rank > rank {
					rank = entry.rank
				}
			}
			if rank == 0 {
				continue
			}
			var total float64
			var cumulative *float64
			for _, entry := range entries {
				if entry.rank != rank {
					continue
				}
				if field == "aicTotal" {
					if value, ok := entry.fields["aic"].(float64); ok {
						total += value
					}
					if value, ok := entry.fields["totalAic"].(float64); ok {
						cumulative = &value
					}
				} else if value, ok := entry.fields[field].(int64); ok {
					total += float64(value)
				}
			}
			if cumulative != nil {
				total = *cumulative
			}
			if field == "aicTotal" {
				previous, _ := run[field].(float64)
				if math.IsInf(previous+total, 0) {
					postgresxLog.Printf("conclusion usage aggregate exceeds the canonical numeric range field=%s", field)
					delete(run, field)
					invalid[field] = true
					continue
				}
				run[field] = previous + total
			} else {
				postgresxLog.Printf("conclusion usage aggregate exceeds the canonical integer range field=%s", field)
				previous, _ := run[field].(int64)
				if total+float64(previous) <= 1<<53-1 {
					run[field] = previous + int64(total)
				} else {
					delete(run, field)
					invalid[field] = true
				}
			}
		}
	}
}
