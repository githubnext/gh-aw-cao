package postgresx

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

var evidenceKinds = map[string]bool{
	"contract": true, "intent-source": true, "requirement": true, "output": true,
	"output-implementation": true, "output-evidence": true, "implementation": true,
	"implementation-evidence": true, "implementation-lineage": true, "snapshot": true,
	"snapshot-item": true, "quality-check": true, "coverage": true, "limitation": true,
}
var evidenceSlug = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var evidenceDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var evidenceRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:._/-]*$`)

func evidenceComponent(value string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(value))
}

func evidenceText(value any) string {
	text, _ := value.(string)
	return text
}

func evidenceTime(value any) (time.Time, error) {
	text := evidenceText(value)
	if !strings.HasSuffix(text, "Z") {
		return time.Time{}, errors.New("evidence timestamps require UTC")
	}
	instant, err := time.Parse(time.RFC3339Nano, text)
	if separator := strings.IndexAny(text, ".,"); err == nil && separator >= 0 {
		fraction := text[separator+1 : len(text)-1]
		if len(fraction) > 6 && strings.Trim(fraction[6:], "0") != "" {
			return time.Time{}, errors.New("evidence timestamps require microsecond precision or coarser")
		}
	}
	return instant, err
}

func validateOperationalValueEvidence(row model.Row) error {
	fail := func() error { return errors.New("invalid bounded operational value evidence packet") }
	repository, workflow := evidenceText(row["repository"]), evidenceText(row["workflow"])
	start, startErr := evidenceTime(row["windowStart"])
	end, endErr := evidenceTime(row["windowEnd"])
	capture, captureErr := evidenceTime(row["observedAt"])
	facts, ok := row["facts"].([]any)
	content, err := json.Marshal(row)
	if !ok || len(facts) < 1 || len(facts) > 20000 || err != nil || len(content) > 8<<20 ||
		fmt.Sprint(row["schemaVersion"]) != "1" || evidenceText(row["schemaVersion"]) != "" || !targetCoordinate.MatchString(repository) ||
		row["sourcePath"] != ".github/workflows/"+workflow+".md" ||
		!evidenceSlug.MatchString(workflow) || !evidenceDigest.MatchString(evidenceText(row["contractDigest"])) ||
		startErr != nil || endErr != nil || captureErr != nil || !start.Before(end) || end.After(capture) {
		return fail()
	}
	allowed := map[string]bool{"schemaVersion": true, "id": true, "repository": true, "workflow": true,
		"sourcePath": true, "observedAt": true, "windowStart": true, "windowEnd": true,
		"contractDigest": true, "facts": true, "repositoryId": true, "workflowId": true, "provenance": true}
	for key := range row {
		if !allowed[key] {
			return fail()
		}
	}
	for field, expected := range map[string]string{
		"repositoryId": "repository:" + evidenceComponent(strings.ToLower(repository)),
		"workflowId":   "workflow:" + evidenceComponent(strings.ToLower(repository)+":"+evidenceText(row["sourcePath"])),
	} {
		if value, present := row[field]; present && value != expected {
			return fail()
		}
	}
	columns := map[string]entityColumn{}
	for _, column := range entityTables["$operationalValueEvidence.facts"].columns {
		if column.field != "id" && column.field != "packetId" {
			columns[column.field] = column
		}
	}
	seen, parents := map[string]bool{}, map[string]map[string]any{}
	var header map[string]any
	var coverage [][2]time.Time
	for _, item := range facts {
		fact, ok := item.(map[string]any)
		if !ok {
			return fail()
		}
		kind, id := evidenceText(fact["fact-kind"]), evidenceText(fact["fact-id"])
		key := fmt.Sprintf("%q:%q:%q", kind, evidenceText(fact["parent-id"]), id)
		if !evidenceKinds[kind] || id == "" || seen[key] {
			return fail()
		}
		seen[key] = true
		for field, value := range fact {
			column, declared := columns[field]
			if !declared || value == nil {
				return fail()
			}
			if _, err := column.bind(value); err != nil {
				return fail()
			}
			if column.kind == "" && (strings.TrimSpace(evidenceText(value)) == "" || len(evidenceText(value)) > 16384) {
				return fail()
			}
			if number, ok := value.(float64); ok && (math.IsNaN(number) || math.IsInf(number, 0)) {
				return fail()
			}
			if column.kind == "timestamp" {
				at, err := evidenceTime(value)
				if err != nil || at.After(capture) {
					return fail()
				}
			}
		}
		if value, exists := fact["url"]; exists {
			address, err := url.Parse(evidenceText(value))
			if err != nil || address.Scheme != "https" || address.Host == "" || address.User != nil {
				return fail()
			}
		}
		if value, exists := fact["ref"]; exists {
			ref := evidenceText(value)
			lower := strings.ToLower(ref)
			if !evidenceRef.MatchString(ref) || strings.HasPrefix(lower, "head") || strings.HasPrefix(lower, "main") ||
				strings.HasPrefix(lower, "master") || strings.HasPrefix(lower, "refs/heads/") {
				return fail()
			}
		}
		switch kind {
		case "contract":
			if header != nil {
				return fail()
			}
			header = fact
		case "snapshot", "implementation", "output":
			at, err := evidenceTime(fact["at"])
			if err != nil || at.Before(start) || at.After(end) {
				return fail()
			}
			if kind != "output" && (fact["value"] == nil || evidenceText(fact["ref"]) == "") {
				return fail()
			}
			if kind == "snapshot" {
				if _, ok := fact["items-available"].(bool); !ok {
					return fail()
				}
			}
			if kind == "implementation" {
				accepted, err := evidenceTime(fact["accepted-at"])
				origin := evidenceText(fact["origin"])
				if err != nil || !accepted.Equal(at) ||
					(origin != "receipt-verified" && origin != "corroborated" && origin != "not-applicable") {
					return fail()
				}
			}
			if kind == "output" {
				origin, state := evidenceText(fact["origin"]), evidenceText(fact["state"])
				if evidenceText(fact["label"]) == "" || evidenceText(fact["title"]) == "" || evidenceText(fact["url"]) == "" ||
					(state != "open" && state != "closed" && state != "unknown") ||
					(origin != "receipt-verified" && origin != "corroborated") {
					return fail()
				}
			}
			parents[kind+":"+id] = fact
		case "coverage":
			left, le := evidenceTime(fact["at"])
			right, re := evidenceTime(fact["end-at"])
			status := evidenceText(fact["coverage-status"])
			if le != nil || re != nil || !left.Before(right) || left.Before(start) || right.After(end) ||
				(status != "complete" && status != "partial" && status != "missing" && status != "unknown") {
				return fail()
			}
			coverage = append(coverage, [2]time.Time{left, right})
		case "quality-check":
			if fact["status"] != "verified" && fact["status"] != "not-verified" {
				return fail()
			}
		}
	}
	if header == nil || len(coverage) == 0 {
		return fail()
	}
	number := func(value any) float64 {
		text := fmt.Sprint(value)
		var result float64
		_, err := fmt.Sscan(text, &result)
		if err != nil {
			return math.NaN()
		}
		return result
	}
	if cadence := number(header["cadence-days"]); math.IsNaN(cadence) || cadence <= 0 {
		return fail()
	}
	if value, exists := header["maturation-days"]; exists {
		days := number(value)
		if math.IsNaN(days) || days < 0 || days != math.Trunc(days) || days > 9007199254740991 {
			return fail()
		}
	}
	if header["repository-state-available"] == true {
		for _, field := range []string{"snapshot-id", "snapshot-name", "snapshot-unit", "snapshot-version", "snapshot-formula"} {
			if evidenceText(header[field]) == "" {
				return fail()
			}
		}
		if header["snapshot-direction"] != "increase" && header["snapshot-direction"] != "decrease" {
			return fail()
		}
	}
	sort.Slice(coverage, func(i, j int) bool { return coverage[i][0].Before(coverage[j][0]) })
	for index := 1; index < len(coverage); index++ {
		if coverage[index][0].Before(coverage[index-1][1]) {
			return fail()
		}
	}
	for _, field := range []string{"goal", "acceptance", "workflow-name", "metric-id", "metric-name", "metric-unit", "metric-version", "metric-formula", "measurement-basis"} {
		if strings.TrimSpace(evidenceText(header[field])) == "" {
			return fail()
		}
	}
	if (header["metric-direction"] != "increase" && header["metric-direction"] != "decrease") ||
		(header["measurement-basis"] != "repository-outcome" && header["measurement-basis"] != "workflow-contribution") {
		return fail()
	}
	identity := strings.ToLower(repository) + ":" + workflow + ":" + evidenceText(header["metric-id"]) + ":" + evidenceText(header["metric-version"])
	if row["id"] != "operational-value-evidence:"+evidenceComponent(identity) {
		return fail()
	}
	for kind, field := range map[string]string{"output": "outputs-available", "snapshot": "repository-state-available", "quality-check": "checks-available"} {
		available, ok := header[field].(bool)
		if !ok {
			return fail()
		}
		for _, item := range facts {
			if !available && item.(map[string]any)["fact-kind"] == kind {
				return fail()
			}
		}
	}
	for _, item := range facts {
		fact := item.(map[string]any)
		kind := evidenceText(fact["fact-kind"])
		parent := ""
		switch {
		case strings.HasPrefix(kind, "output-"):
			parent = "output"
		case strings.HasPrefix(kind, "implementation-"):
			parent = "implementation"
		case kind == "snapshot-item":
			parent = "snapshot"
		}
		if parent != "" && parents[parent+":"+evidenceText(fact["parent-id"])] == nil {
			return fail()
		}
		if kind == "snapshot-item" && parents["snapshot:"+evidenceText(fact["parent-id"])]["items-available"] != true {
			return fail()
		}
		if kind == "implementation-lineage" && header["outputs-available"] == true &&
			parents["output:"+evidenceText(fact["related-id"])] == nil {
			return fail()
		}
		if kind == "output-implementation" {
			event := parents["implementation:"+evidenceText(fact["related-id"])]
			output := parents["output:"+evidenceText(fact["parent-id"])]
			if event == nil {
				return fail()
			}
			accepted, _ := evidenceTime(event["at"])
			created, _ := evidenceTime(output["at"])
			if accepted.Before(created) {
				return fail()
			}
		}
	}
	return nil
}
