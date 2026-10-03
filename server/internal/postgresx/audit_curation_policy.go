package postgresx

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

const auditSummaryLimit = 1024
const auditExponentDigits = 3

var (
	auditNumberPattern = fmt.Sprintf(`(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]{1,%d})?`, auditExponentDigits)
	auditAICSummary    = regexp.MustCompile(`^AIC (` + auditNumberPattern + `)$`)
	auditCountSummary  = regexp.MustCompile(`^(0|[1-9][0-9]*) safe output items$`)
	auditInstant       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)
)

func auditCurationMarker(row model.Row) bool {
	source, _ := row["source"].(string)
	kind, _ := row["type"].(string)
	status, _ := row["status"].(string)
	summary, present := row["summary"].(string)
	if !present {
		return false
	}
	switch source {
	case "gh-aw-logs":
		return kind == "workflow_run_comparison" && status == "unavailable" && summary == "No baseline comparison" ||
			kind == "workflow_run_working_set" && status == "observed" && summary == "Working set measured"
	case "agent":
		return kind == "agent.session" && status == "completed" && summary == ""
	case "audit":
		return status == "low" && (kind == "audit.observability" && summary == "1 anomalous event pattern(s) detected" ||
			kind == "audit.recommendation" && summary == "Monitor workflow performance over time")
	default:
		return false
	}
}

func auditText(row model.Row, field string) string {
	text, _ := row[field].(string)
	return text
}

func auditTimestamp(value any) (time.Time, bool) {
	text, ok := value.(string)
	if !ok || !auditInstant.MatchString(text) {
		return time.Time{}, false
	}
	instant, err := time.Parse(time.RFC3339Nano, text)
	return instant, err == nil
}

func auditSameInstant(left, right any) bool {
	a, validA := auditTimestamp(left)
	b, validB := auditTimestamp(right)
	return validA && validB && a.Equal(b)
}

func auditFiniteNumber(value any) (float64, bool) {
	var number float64
	switch value := value.(type) {
	case json.Number:
		parsed, err := strconv.ParseFloat(string(value), 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	case float64:
		number = value
	case float32:
		number = float64(value)
	case int:
		number = float64(value)
	case int32:
		number = float64(value)
	case int64:
		number = float64(value)
	case uint64:
		number = float64(value)
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
}

// discardAuditCopy is the row-level contract. Native ingestion and maintenance
// perform the equivalent checks in SQL, without retaining Run facts in Go.
func discardAuditCopy(audit, run model.Row) bool {
	if _, valid := auditTimestamp(audit["timestamp"]); !valid {
		return false
	}
	for field, value := range audit {
		if value != nil && !auditMetadataField(field) &&
			(field != "code" || auditText(audit, "type") != "audit.finding" || value != "workflow_failed") {
			return false
		}
	}
	if auditCurationMarker(audit) {
		return true
	}
	if run == nil || auditText(run, "id") == "" || auditText(run, "id") != auditText(audit, "runId") {
		return false
	}
	source, kind := auditText(audit, "source"), auditText(audit, "type")
	status, summary := auditText(audit, "status"), auditText(audit, "summary")
	if source == "audit" {
		return kind == "audit.finding" && status == "critical" && summary == "Workflow Failed" &&
			auditText(audit, "code") == "workflow_failed" && auditText(run, "conclusion") == "failure"
	}
	if source != "gh-aw-logs" {
		return false
	}
	switch kind {
	case "workflow_run_started":
		start := run["startedAt"]
		if start == nil {
			start = run["createdAt"]
		}
		return status != "" && status == auditText(run, "status") && auditSameInstant(audit["timestamp"], start)
	case "workflow_run_completed":
		classification := auditText(run, "classification")
		if classification == "" {
			classification = auditText(run, "conclusion")
		}
		return status != "" && status == auditText(run, "conclusion") && summary == classification &&
			auditSameInstant(audit["timestamp"], run["completedAt"])
	case "workflow_run_failed":
		failure := auditText(run, "failureKind")
		if status != "failure" || auditText(run, "conclusion") != "failure" && failure == "" {
			return false
		}
		if failure == "" {
			failure = "workflow run failed"
		}
		return summary == failure
	case "workflow_run_usage":
		if len(summary) > auditSummaryLimit {
			return false
		}
		match := auditAICSummary.FindStringSubmatch(summary)
		total, valid := auditFiniteNumber(run["aicTotal"])
		if status != "observed" || !valid || match == nil {
			return false
		}
		value, err := strconv.ParseFloat(match[1], 64)
		return err == nil && !math.IsInf(value, 0) && value >= 0 && value == total
	case "workflow_run_safe_outputs":
		if len(summary) > auditSummaryLimit {
			return false
		}
		match := auditCountSummary.FindStringSubmatch(summary)
		total, valid := auditFiniteNumber(run["safeItemsCount"])
		if status != "observed" || !valid || total < 0 || total > 9007199254740991 || math.Trunc(total) != total || match == nil {
			return false
		}
		value, err := strconv.ParseFloat(match[1], 64)
		return err == nil && value <= 9007199254740991 && value == total
	default:
		return false
	}
}
