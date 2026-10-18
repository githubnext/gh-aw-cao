package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Quickstart consumes only uniqueRawRuns from auditJsonlDirectory. Canonical
// entity construction, ordering and curation cannot change that count. This
// projection retains the adapter/normalizer's rejecting validations, including
// deferred validation of the winning enriched run and its linked evidence.
type nativeQuickstartAudit struct {
	err            error
	raw            map[string]nativeQuickstartAuditRun
	enriched       map[string]nativeQuickstartAuditRun
	retained       map[string]string
	safe           map[string][]map[string]any
	tokens         map[string][]map[string]any
	lifecycles     map[string][]map[string]any
	lifecycleOrder []string
	operational    []struct {
		value map[string]any
		field string
	}
}

type nativeQuickstartAuditRun struct {
	value    map[string]any
	observed time.Time
	attempt  float64
}

func (a *nativeQuickstartAudit) fail(format string, args ...any) {
	if a.err == nil {
		a.err = nativeErrorf(format, args...)
	}
}

func (a *nativeQuickstartAudit) object(value any, field string) map[string]any {
	result, ok := value.(map[string]any)
	if !ok || result == nil {
		a.fail("%s must be an object", field)
	}
	return result
}

func (a *nativeQuickstartAudit) text(value any, field string) string {
	result, ok := value.(string)
	if !ok || strings.TrimSpace(result) == "" {
		a.fail("%s is required", field)
	}
	return strings.TrimSpace(result)
}

func (a *nativeQuickstartAudit) identifier(value any, field string) string {
	switch value := value.(type) {
	case string:
		return a.text(value, field)
	case json.Number:
		number, err := value.Float64()
		if err == nil || math.IsInf(number, 0) {
			if number == 0 {
				return "0"
			}
			if math.IsInf(number, 1) {
				return "Infinity"
			}
			if math.IsInf(number, -1) {
				return "-Infinity"
			}
			format := byte('f')
			if math.Abs(number) >= 1e21 || (number != 0 && math.Abs(number) < 1e-6) {
				format = 'e'
			}
			result := strconv.FormatFloat(number, format, -1, 64)
			return strings.ReplaceAll(strings.ReplaceAll(result, "e-0", "e-"), "e+0", "e+")
		}
	}
	a.fail("%s is required", field)
	return ""
}

func nativeQuickstartAuditNumber(value any) float64 {
	switch value := value.(type) {
	case nil:
		return 0
	case bool:
		if value {
			return 1
		}
		return 0
	case string:
		value = strings.TrimSpace(value)
		if value == "" {
			return 0
		}
		if number, err := strconv.ParseFloat(value, 64); err == nil {
			return number
		}
		if !strings.HasPrefix(value, "+") && !strings.HasPrefix(value, "-") {
			if number, err := strconv.ParseUint(value, 0, 64); err == nil {
				return float64(number)
			}
		}
		return math.NaN()
	case []any:
		if len(value) == 0 {
			return 0
		}
		if len(value) == 1 {
			return nativeQuickstartAuditNumber(nativeQuickstartAuditArrayString(value))
		}
		return math.NaN()
	default:
		return nativeNumber(value)
	}
}

func nativeQuickstartAuditArrayString(value []any) string {
	parts := make([]string, len(value))
	for i, item := range value {
		switch item := item.(type) {
		case nil:
		case []any:
			parts[i] = nativeQuickstartAuditArrayString(item)
		case map[string]any:
			parts[i] = "[object Object]"
		default:
			parts[i] = fmt.Sprint(item)
		}
	}
	return strings.Join(parts, ",")
}

func (a *nativeQuickstartAudit) positive(value any, field string) float64 {
	number := nativeQuickstartAuditNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < 1 {
		a.fail("%s must be a positive integer", field)
	}
	return number
}

func nativeQuickstartAuditDefault(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}

func nativeQuickstartAuditParseTime(value string) (time.Time, bool) {
	// Date.parse normalizes ISO day overflow and permits 24:00 and compact
	// offsets. Operational-value measurement periods use the strict parser.
	match := regexp.MustCompile(`^([+-][0-9]{6}|[0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$`).FindStringSubmatch(value)
	if match != nil {
		values := make([]int, 7)
		for i := 1; i <= 6; i++ {
			values[i], _ = strconv.Atoi(match[i])
		}
		year, month, day, hour, minute, second := values[1], values[2], values[3], values[4], values[5], values[6]
		millisecond, _ := strconv.Atoi((match[7] + "000")[:3])
		if match[1] == "-000000" || month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute != 0 || second != 0 || millisecond != 0)) {
			return time.Time{}, false
		}
		location := time.UTC
		if match[4] != "" && match[8] == "" {
			location = time.Local
		} else if offset := match[8]; len(offset) > 1 {
			digits := strings.ReplaceAll(offset[1:], ":", "")
			offsetHour, _ := strconv.Atoi(digits[:2])
			offsetMinute, _ := strconv.Atoi(digits[2:])
			if offsetHour > 23 || offsetMinute > 59 {
				return time.Time{}, false
			}
			seconds := offsetHour*3600 + offsetMinute*60
			if offset[0] == '-' {
				seconds = -seconds
			}
			location = time.FixedZone("", seconds)
		}
		result := time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), location)
		if milliseconds := result.UnixMilli(); milliseconds >= -8640000000000000 && milliseconds <= 8640000000000000 {
			return result, true
		}
		return time.Time{}, false
	}
	for _, layout := range []string{
		"2006-01", "2006",
		time.RFC1123, time.RFC1123Z, time.RFC850, time.RFC822, time.RFC822Z,
		"Jan 2, 2006", "January 2, 2006", "1/2/2006",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.Truncate(time.Millisecond), true
		}
	}
	return time.Time{}, false
}

func (a *nativeQuickstartAudit) timestamp(value any, field string) time.Time {
	text := a.text(value, field)
	result, ok := nativeQuickstartAuditParseTime(text)
	if !ok {
		a.fail("%s must be a valid timestamp", field)
	}
	return result
}

func (a *nativeQuickstartAudit) repository(value, fallback, field string) string {
	parts := []string{}
	for _, part := range strings.Split(value, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	owner, name := fallback, value
	if len(parts) == 2 {
		owner, name = parts[0], parts[1]
	}
	if owner == "" || name == "" {
		a.fail("Repository must use OWNER/REPOSITORY form: %s", value)
	}
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(name) == "" {
		a.fail("Run repository owner and name are required")
	}
	return strings.ToLower(strings.TrimSpace(owner) + "/" + strings.TrimSpace(name))
}

func nativeQuickstartAuditKeep(records map[string]nativeQuickstartAuditRun, key string, incoming nativeQuickstartAuditRun) {
	old, exists := records[key]
	if !exists {
		records[key] = incoming
		return
	}
	newer, older := incoming, old
	if incoming.observed.Before(old.observed) {
		newer, older = old, incoming
	}
	if newer.attempt == older.attempt {
		merged := make(map[string]any, len(older.value)+len(newer.value))
		for key, value := range older.value {
			merged[key] = value
		}
		for key, value := range newer.value {
			merged[key] = value
		}
		newer.value = merged
	}
	records[key] = newer
}

func (a *nativeQuickstartAudit) accept(envelope map[string]any, line int) {
	prefix := fmt.Sprintf("gh-aw JSONL line %d", line)
	version := nativeNumber(envelope["schema_version"])
	if version != 2 && version != 4 && version != 5 {
		value := fmt.Sprint(envelope["schema_version"])
		switch schema := envelope["schema_version"].(type) {
		case map[string]any:
			value = "[object Object]"
		case []any:
			value = nativeQuickstartAuditArrayString(schema)
		}
		if _, exists := envelope["schema_version"]; !exists {
			value = "undefined"
		} else if envelope["schema_version"] == nil {
			value = "null"
		}
		a.fail("Unsupported gh-aw JSONL schema version at line %d: %s", line, value)
		return
	}
	kind := a.text(envelope["kind"], prefix+".kind")
	switch kind {
	case "workflow_runs":
		request := a.object(envelope["request"], prefix+".request")
		repository := a.repository(a.text(request["repository"], prefix+".request.repository"), "", prefix)
		payload, ok := envelope["payload"].([]any)
		if !ok {
			a.fail("%s.payload must be an array", prefix)
			return
		}
		for i, value := range payload {
			path := fmt.Sprintf("%s.payload[%d]", prefix, i)
			run := a.object(value, path)
			id := a.identifier(run["databaseId"], path+".databaseId")
			attempt := a.positive(nativeQuickstartAuditDefault(run["attempt"], json.Number("1")), path+".attempt")
			a.text(run["workflowName"], path+".workflowName")
			observed := a.timestamp(nativeQuickstartAuditDefault(run["updatedAt"], run["createdAt"]), path+".updatedAt")
			nativeQuickstartAuditKeep(a.raw, repository+":"+id, nativeQuickstartAuditRun{value: run, observed: observed, attempt: attempt})
		}
	case "run", "token_efficiency_run_context":
		run := a.object(envelope["run"], prefix+".run")
		owner := a.text(run["organization"], prefix+".run.organization")
		repository := a.repository(a.text(run["repository"], prefix+".run.repository"), owner, prefix)
		a.text(run["workflow_name"], prefix+".run.workflow_name")
		a.text(run["workflow_path"], prefix+".run.workflow_path")
		id := a.identifier(run["run_id"], prefix+".run.run_id")
		attempt := a.positive(nativeQuickstartAuditDefault(run["run_attempt"], json.Number("1")), prefix+".run.run_attempt")
		observed := a.timestamp(nativeQuickstartAuditDefault(run["updated_at"], run["created_at"]), prefix+".run.updated_at")
		nativeQuickstartAuditKeep(a.enriched, repository+":"+id, nativeQuickstartAuditRun{value: run, observed: observed, attempt: attempt})
		a.retained[id] = repository + ":" + id
	case "safe_output_item":
		output := a.object(envelope["safe_output"], prefix+".safe_output")
		id := a.identifier(output["run_id"], prefix+".safe_output.run_id")
		if key := a.retained[id]; key != "" {
			a.safe[key] = append(a.safe[key], output)
		}
	case "token_efficiency_observation", "token_efficiency_lifecycle_observation":
		observation := a.object(envelope["observation"], prefix+".observation")
		id := a.identifier(observation["optimizerRunId"], prefix+".observation.optimizerRunId")
		if kind == "token_efficiency_observation" {
			a.positive(nativeQuickstartAuditDefault(observation["runAttempt"], json.Number("1")), prefix+".observation.runAttempt")
			a.tokens[id] = append(a.tokens[id], observation)
		} else {
			a.positive(observation["optimizerRunAttempt"], prefix+".observation.optimizerRunAttempt")
			if _, exists := a.lifecycles[id]; !exists {
				a.lifecycleOrder = append(a.lifecycleOrder, id)
			}
			a.lifecycles[id] = append(a.lifecycles[id], observation)
		}
	case "operational_value":
		a.operational = append(a.operational, struct {
			value map[string]any
			field string
		}{a.object(envelope["operational_value"], prefix+".operational_value"), prefix + ".operational_value"})
	}
	// Unknown kinds and rate-limit payloads are deliberately ignored. The JS
	// audit passes no collection context, so it never maps rate-limit records.
}

func (a *nativeQuickstartAudit) finish() {
	for _, entry := range a.operational {
		a.operationalValue(entry.value, entry.field)
	}
	keys := make([]string, 0, len(a.enriched))
	for key := range a.enriched {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	// The adapter projects metadata for every selected run before processing
	// any session events, so preserve its validation/error ordering.
	for _, key := range keys {
		run := a.enriched[key]
		if raw, exists := a.raw[key]; !exists || raw.attempt == run.attempt {
			a.sessionMetadata(run.value)
		}
	}
	for _, key := range keys {
		run := a.enriched[key]
		raw, rawExists := a.raw[key]
		matchesAttempt := !rawExists || raw.attempt == run.attempt
		value := run.value
		outputValue := value["safe_outputs"]
		if _, ok := outputValue.([]any); !ok {
			outputValue = nativeSetupMap(value["audit"])["created_items"]
		}
		var sessionOutputs []any
		if _, exists := value["cao_unified_session"]; exists {
			session := a.sessionMetadata(value)
			if metadata, exists := session["run"]; exists {
				fields := nativeSetupMap(metadata)
				if outputs, ok := fields["safe_outputs"].([]any); ok {
					sessionOutputs = outputs
				} else if _, exists := fields["safe_outputs"]; exists {
					outputValue = nativeSetupMap(value["audit"])["created_items"]
				}
			}
			if !matchesAttempt {
				continue
			}
			a.text(session["path"], "run.cao_unified_session.path")
			events, ok := session["events"].([]any)
			if !ok {
				a.fail("Unified session evidence must be an array")
			}
			for _, value := range events {
				event := a.object(value, "unified session evidence")
				a.positive(event["line"], "session line")
				if stamp, exists := event["timestamp"]; exists {
					a.timestamp(stamp, "session timestamp")
				}
				a.text(event["source"], "session source")
				eventType := a.text(event["type"], "session type")
				fields := a.object(event["fields"], "session fields")
				if key, exists := event["key"]; exists {
					a.text(key, "session event key")
				}
				if eventType == "safe_output.result" || eventType == "safe_output.created" {
					a.issue(fields["correlationId"], fields["githubEntityType"])
				}
			}
		}
		if !matchesAttempt {
			continue
		}
		id := a.identifier(value["run_id"], "run.run_id")
		for _, token := range a.tokens[id] {
			target := a.text(token["targetRepo"], "token observation targetRepo")
			if !repositoryPattern.MatchString(strings.ToLower(target)) {
				continue
			}
			for _, field := range []string{"workflowPath", "opportunityId", "interventionId"} {
				a.text(token[field], "token observation "+field)
			}
		}
		for _, lifecycle := range a.lifecycles[id] {
			a.lifecycle(lifecycle)
		}
		outputs, _ := outputValue.([]any)
		if sessionOutputs != nil {
			outputs = sessionOutputs
		} else if len(a.safe[key]) > 0 {
			outputs = make([]any, 0, len(a.safe[key]))
			for _, entry := range a.safe[key] {
				outputs = append(outputs, entry)
			}
		}
		for _, output := range outputs {
			fields := nativeSetupMap(output)
			entity := nativeQuickstartAuditEntity(fields)
			a.issue(nativeQuickstartAuditOptionalString(nativeQuickstartAuditDefault(fields["url"], fields["temporaryId"])), entity)
		}
	}
	unmatched := []string{}
	for _, id := range a.lifecycleOrder {
		if a.retained[id] == "" {
			unmatched = append(unmatched, id)
		}
	}
	if len(unmatched) != 0 {
		a.fail("Token lifecycle observations require retained optimizer runs: %s", strings.Join(unmatched, ", "))
	}
}

func (a *nativeQuickstartAudit) sessionMetadata(value map[string]any) map[string]any {
	sessionValue, exists := value["cao_unified_session"]
	if !exists {
		return nil
	}
	session := a.object(sessionValue, "run.cao_unified_session")
	if nativeNumber(session["version"]) != 1 {
		a.fail("Unsupported unified session evidence version")
	}
	if metadata, exists := session["run"]; exists {
		fields := a.object(metadata, "unified session run metadata")
		if usage, exists := fields["token_usage_summary"]; exists {
			a.object(usage, "session token usage")
		}
	}
	return session
}

func nativeQuickstartAuditEntity(value map[string]any) string {
	if provider, exists := value["provider"]; exists && !strings.EqualFold(fmt.Sprint(provider), "github") {
		return ""
	}
	if target := nativeSetupMap(value["target"]); target["kind"] != nil {
		if kind := nativeQuickstartAuditOptionalString(target["kind"]); kind != "" {
			return strings.ReplaceAll(strings.ToLower(kind), "-", "_")
		}
	}
	if address := nativeQuickstartAuditOptionalString(value["url"]); address != "" {
		parsed, err := url.Parse(address)
		if err == nil && strings.EqualFold(parsed.Hostname(), "github.com") {
			for path, kind := range map[string]string{"pull": "pull_request", "issues": "issue", "discussions": "discussion", "projects": "project"} {
				if regexp.MustCompile("/" + path + `/\d+(?:/|$)`).MatchString(parsed.EscapedPath()) {
					return kind
				}
			}
		}
	}
	action := nativeQuickstartAuditOptionalString(value["type"])
	for _, kind := range []string{"pull_request_review_comment", "pull_request_review", "pull_request", "discussion", "project_status_update", "project", "code_scanning_alert", "issue"} {
		if strings.Contains(strings.ToLower(action), kind) {
			return kind
		}
	}
	return ""
}

func nativeQuickstartAuditOptionalString(value any) string {
	switch value := value.(type) {
	case nil:
		return ""
	case []any:
		return nativeQuickstartAuditArrayString(value)
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(value)
	}
}

func (a *nativeQuickstartAudit) issue(address, kind any) {
	if kind != "issue" && kind != "pull_request" {
		return
	}
	text, ok := address.(string)
	if !ok {
		return
	}
	parsed, err := url.Parse(text)
	if err != nil || !strings.EqualFold(parsed.Hostname(), "github.com") {
		return
	}
	match := regexp.MustCompile(`^/([^/]+)/([^/]+)/(?:issues|pull)/(\d+)(?:/|$)`).FindStringSubmatch(parsed.EscapedPath())
	if len(match) != 4 {
		return
	}
	number, _ := strconv.ParseFloat(match[3], 64)
	if number < 1 || math.IsInf(number, 0) {
		a.fail("Issue number must be a positive integer")
	}
}

func (a *nativeQuickstartAudit) enum(value any, field string, choices ...string) {
	text := a.text(value, field)
	if !nativeQuickstartContains(choices, text) {
		a.fail("%s must be one of %s", field, strings.Join(choices, ", "))
	}
}

func (a *nativeQuickstartAudit) lifecycle(value map[string]any) {
	a.timestamp(value["observedAt"], "token lifecycle observedAt")
	target := a.text(value["targetRepo"], "token lifecycle targetRepo")
	if !repositoryPattern.MatchString(strings.ToLower(target)) {
		a.fail("token lifecycle targetRepo must be an owner/repository coordinate")
	}
	for _, field := range []string{"workflowPath", "opportunityId", "interventionId", "lifecycleObservationId"} {
		a.text(value[field], "token lifecycle "+field)
	}
	for _, field := range []string{"previousInterventionState", "interventionState"} {
		a.enum(value[field], "token lifecycle "+field, "proposed", "accepted", "running", "verified", "regressed", "inconclusive", "rejected")
	}
	for _, field := range []string{"previousRecommendationDisposition", "recommendationDisposition"} {
		a.enum(value[field], "token lifecycle "+field, "applied", "superseded", "outdated", "duplicate", "unapplied", "failed-start", "rejected")
	}
	a.enum(value["evidenceState"], "token lifecycle evidenceState", "complete", "incomplete", "unavailable")
	a.positive(value["optimizerRunAttempt"], "token lifecycle optimizerRunAttempt")
	for _, field := range []string{"optimizerWorkflowPath", "optimizerWorkflowName", "safeOutputId", "safeOutputUrl"} {
		a.text(value[field], "token lifecycle "+field)
	}
	if ids := value["implementationRunIds"]; ids != nil {
		values, ok := ids.([]any)
		if !ok {
			a.fail("token lifecycle implementationRunIds must be an array")
		}
		for i, id := range values {
			a.identifier(id, fmt.Sprintf("token lifecycle implementationRunIds[%d]", i))
		}
	}
	for _, field := range []string{"acceptedAt", "implementationStartedAt", "implementationCompletedAt", "rejectedAt", "supersededAt"} {
		if stamp := value[field]; stamp != nil {
			a.timestamp(stamp, "token lifecycle "+field)
		}
	}
	a.identifier(value["claimRunId"], "token lifecycle claimRunId")
	a.positive(value["claimRunAttempt"], "token lifecycle claimRunAttempt")
	a.text(value["actor"], "token lifecycle actor")
	a.object(value["sourceProvenance"], "token lifecycle sourceProvenance")
}

func (a *nativeQuickstartAudit) operationalValue(value map[string]any, field string) {
	a.repository(a.text(value["repository"], field+".repository"), "", field)
	observed := a.timestamp(value["timestamp"], field+".timestamp")
	a.text(value["value_id"], field+".value_id")
	hasPeriod := false
	for _, key := range []string{"window_start", "window_end", "measurement_kind", "coverage_status"} {
		_, exists := value[key]
		hasPeriod = hasPeriod || exists
	}
	if hasPeriod {
		start, startOK := nativeQuickstartAuditStrictTime(value["window_start"])
		end, endOK := nativeQuickstartAuditStrictTime(value["window_end"])
		if !startOK || !endOK {
			a.fail("%s must contain valid RFC 3339 measurement timestamps", field)
		} else if !start.Before(end) || end.After(observed) || (value["measurement_kind"] != "interval" && value["measurement_kind"] != "snapshot") || !nativeQuickstartContains([]string{"complete", "partial", "missing", "unknown"}, fmt.Sprint(value["coverage_status"])) {
			a.fail("%s must contain a valid measurement period and coverage", field)
		}
	}
	for _, pair := range [][2]string{{"population_digest", "populationDigest"}, {"evidence_digest", "evidenceDigest"}} {
		transport, label := pair[0], pair[1]
		if digest, exists := value[transport]; exists {
			text, ok := digest.(string)
			if !ok || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(text) {
				a.fail("%s.%s must be a SHA-256 fingerprint", field, label)
			}
		}
	}
	if count, exists := value["eligible_count"]; exists {
		number := nativeNumber(count)
		if math.IsNaN(number) || number < 0 || number > 9007199254740991 || number != math.Trunc(number) {
			a.fail("%s.eligibleCount must be a non-negative safe integer", field)
		}
	}
	if reason, exists := value["missing_reason"]; exists {
		a.text(reason, field+".missingReason")
	}
	metric := nativeQuickstartAuditNumber(value["value"])
	if value["value"] == nil || value["value"] == "" {
		metric = math.NaN()
	}
	_, hasMetric := value["value"]
	unavailable := hasMetric && value["value"] == nil && hasPeriod && value["missing_reason"] != nil && value["maturity_status"] == "unavailable"
	if (math.IsNaN(metric) || math.IsInf(metric, 0)) && !unavailable {
		a.fail("%s.value must be a finite number", field)
	}
	if cadence, exists := value["cadence_days"]; exists {
		number := nativeNumber(cadence)
		if math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
			a.fail("%s.cadence_days must be a positive finite number", field)
		}
	}
	if digest, exists := value["evaluator_digest"]; exists {
		text, ok := digest.(string)
		if !ok || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(text) {
			a.fail("%s.evaluator_digest must be a SHA-256 fingerprint", field)
		}
	}
	numerator, hasNumerator := value["rollup_numerator"]
	denominator, hasDenominator := value["rollup_denominator"]
	n, d := nativeQuickstartAuditNumber(numerator), nativeQuickstartAuditNumber(denominator)
	if hasNumerator != hasDenominator || (hasNumerator && (math.IsNaN(metric) || numerator == nil || numerator == "" || denominator == nil || denominator == "" || math.IsNaN(n) || math.IsNaN(d) || math.IsInf(n, 0) || math.IsInf(d, 0) || n < 0 || d <= 0)) {
		a.fail("%s must contain a valid rollup numerator and denominator together", field)
	}
}

func nativeQuickstartAuditStrictTime(value any) (time.Time, bool) {
	text, ok := value.(string)
	if !ok || !regexp.MustCompile(`^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$`).MatchString(text) || strings.HasPrefix(text, "0000") {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	return parsed.Truncate(time.Millisecond), err == nil
}

func nativeQuickstartCountRuns(input io.Reader) (int, error) {
	audit := nativeQuickstartAudit{
		raw: map[string]nativeQuickstartAuditRun{}, enriched: map[string]nativeQuickstartAuditRun{},
		retained: map[string]string{}, safe: map[string][]map[string]any{}, tokens: map[string][]map[string]any{}, lifecycles: map[string][]map[string]any{},
	}
	reader := bufio.NewReader(input)
	for line := 1; ; line++ {
		text, readErr := reader.ReadString('\n')
		if strings.TrimSpace(text) != "" {
			decoder := json.NewDecoder(strings.NewReader(text))
			decoder.UseNumber()
			var envelope map[string]any
			if err := decoder.Decode(&envelope); err != nil || envelope == nil {
				return 0, nativeErrorf("gh-aw JSONL line %d must contain valid JSON", line)
			}
			if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
				return 0, nativeErrorf("gh-aw JSONL line %d must contain valid JSON", line)
			}
			audit.accept(envelope, line)
			if audit.err != nil {
				return 0, audit.err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, readErr
		}
	}
	audit.finish()
	return len(audit.raw), audit.err
}
