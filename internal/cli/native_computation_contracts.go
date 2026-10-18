package cli

import (
	"crypto/sha256"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
)

var ncSemanticFields = []string{
	"repositoryNativeProblem", "eligibleOpportunity", "intendedOutcome", "outcomeAttainmentEvidence",
	"targetPopulation", "interventionClass", "triggerAndSchedule", "scheduleRationale", "maxDetectionDelay",
	"resourceEnvelope", "overlapIdentity", "outputApprovalPolicy", "maturationPeriod", "deduplication", "backoff",
	"stopConditions", "operationalValueDefinition",
}

func ncFingerprint(value any) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256(ncCanonicalJSON(value)))
}

func ncID(prefix string, value any) string {
	return prefix + ":" + ncFingerprint(value)[7:31]
}

func ncRequired(value any, field string) (string, error) {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	return strings.TrimSpace(text), nil
}

func ncNullable(value any, field string) (any, error) {
	if value == nil || value == "" {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("%s must be a string or null", field)
	}
	if text = strings.TrimSpace(text); text == "" {
		return nil, nil
	}
	return text, nil
}

func ncDimension(value any, allowed string) string {
	state, ok := value.(string)
	if !ok {
		state, ok = ncObject(value)["state"].(string)
		if !ok {
			state = "unknown"
		}
	}
	for _, candidate := range strings.Split(allowed, "|") {
		if state == candidate {
			return state
		}
	}
	return "malformed"
}

func ncCoverage(value any, present bool) ncRecord {
	object := ncObject(value)
	if object == nil {
		state := "malformed"
		if !present {
			state = "unknown"
		}
		return ncRecord{"state": state, "numerator": nil, "denominator": nil}
	}
	state := ncDimension(value, "complete|partial|zero|missing|unavailable|conflicting|malformed|unknown")
	var numerator, denominator any
	if object["numerator"] != nil {
		numerator = ncNumber(object["numerator"])
	}
	if object["denominator"] != nil {
		denominator = ncNumber(object["denominator"])
	}
	valid := func(value any) bool {
		return value == nil || (!math.IsNaN(ncNumber(value)) && !math.IsInf(ncNumber(value), 0) && ncNumber(value) >= 0)
	}
	if !valid(numerator) || !valid(denominator) || (numerator != nil && denominator != nil && ncNumber(numerator) > ncNumber(denominator)) {
		state, numerator, denominator = "malformed", nil, nil
	}
	return ncRecord{"state": state, "numerator": numerator, "denominator": denominator}
}

func ncQuality(value any) ncRecord {
	object := ncObject(value)
	if object == nil {
		return ncRecord{
			"contractId": "evidence-quality", "contractVersion": "1.0.0",
			"availability": "malformed", "completeness": "malformed", "freshness": ncRecord{"state": "malformed", "observedAt": nil},
			"coverage": ncRecord{"state": "malformed", "numerator": nil, "denominator": nil}, "maturity": "malformed",
			"provenance":          ncRecord{"state": "malformed", "sources": []string{}},
			"attributionCoverage": ncRecord{"state": "malformed", "numerator": nil, "denominator": nil}, "contradictionState": "malformed",
		}
	}
	freshness := ncObject(object["freshness"])
	if freshness == nil {
		freshness = ncRecord{"state": object["freshness"]}
	}
	freshnessState := ncDimension(freshness, "fresh|stale|missing|unavailable|malformed|unknown")
	var observedAt any
	if stamp, ok := ncTime(freshness["observedAt"]); ok {
		observedAt = stamp
	}
	if (freshness["observedAt"] != nil && observedAt == nil) || ((freshnessState == "fresh" || freshnessState == "stale") && observedAt == nil) {
		freshnessState = "malformed"
	}
	provenance := ncObject(object["provenance"])
	if provenance == nil {
		provenance = ncRecord{"state": object["provenance"]}
	}
	sources := []string{}
	for _, source := range ncArray(provenance["sources"]) {
		text := ncString(source)
		if source == nil {
			text = "null"
		}
		if text = strings.TrimSpace(text); text != "" {
			sources = append(sources, text)
		}
	}
	_, coveragePresent := object["coverage"]
	_, attributionPresent := object["attributionCoverage"]
	return ncRecord{
		"contractId": "evidence-quality", "contractVersion": "1.0.0",
		"availability":        ncDimension(object["availability"], "available|missing|unavailable|malformed|unknown"),
		"completeness":        ncDimension(object["completeness"], "complete|partial|missing|unavailable|conflicting|malformed|unknown"),
		"freshness":           ncRecord{"state": freshnessState, "observedAt": observedAt},
		"coverage":            ncCoverage(object["coverage"], coveragePresent),
		"maturity":            ncDimension(object["maturity"], "mature|immature|missing|unavailable|malformed|unknown"),
		"provenance":          ncRecord{"state": ncDimension(provenance, "available|partial|missing|unavailable|conflicting|malformed|unknown"), "sources": ncUnique(sources, 0)},
		"attributionCoverage": ncCoverage(object["attributionCoverage"], attributionPresent),
		"contradictionState":  ncDimension(object["contradictionState"], "not-observed|conflicting|malformed|unknown"),
	}
}

func ncNumericEvidence(value any) ncRecord {
	if value == nil || value == "" {
		return ncRecord{"state": "missing", "value": nil}
	}
	switch value.(type) {
	case int, int64, float64:
		number := ncNumber(value)
		if !math.IsInf(number, 0) && !math.IsNaN(number) {
			state := "available"
			if number == 0 {
				state = "zero"
			}
			return ncRecord{"state": state, "value": number}
		}
	}
	return ncRecord{"state": "malformed", "value": nil}
}

func ncDeclaration(value any, campaign, label string) (ncRecord, error) {
	object := ncObject(value)
	if object == nil {
		return nil, fmt.Errorf("%s must be an object", label)
	}
	for key := range object {
		if key != "contractVersion" && key != "campaign" && key != "fields" {
			return nil, fmt.Errorf("%s contains unknown field(s): %s", label, key)
		}
	}
	if object["contractVersion"] != "1.0.0" {
		return nil, fmt.Errorf("%s.contractVersion must be 1.0.0", label)
	}
	slug, ok := object["campaign"].(string)
	if !ok || !regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`).MatchString(slug) {
		return nil, fmt.Errorf("%s.campaign must be a lowercase Campaign slug", label)
	}
	if slug != campaign {
		return nil, fmt.Errorf("%s.campaign must match %s, received %s", label, campaign, slug)
	}
	fields := ncObject(object["fields"])
	if fields == nil {
		return nil, fmt.Errorf("%s.fields must be an object", label)
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("%s.fields must declare at least one semantic field", label)
	}
	for key, value := range fields {
		known := false
		for _, field := range ncSemanticFields {
			if field == key {
				known = true
			}
		}
		if !known {
			return nil, fmt.Errorf("%s.fields contains unknown field(s): %s", label, key)
		}
		if value == nil {
			return nil, fmt.Errorf("%s.fields.%s must be omitted instead of null", label, key)
		}
	}
	return object, nil
}

func ncCampaignContracts(campaigns, workflows []map[string]any) ([]map[string]any, error) {
	contracts := []map[string]any{}
	for _, campaign := range campaigns {
		id, err := ncRequired(campaign["id"], "campaign.id")
		if err != nil {
			return nil, err
		}
		var declaration ncRecord
		if campaign["intelligenceDeclaration"] != nil {
			slug, err := ncRequired(campaign["slug"], "campaign.slug")
			if err != nil {
				return nil, err
			}
			declaration, err = ncDeclaration(campaign["intelligenceDeclaration"], slug, "Campaign "+id+" intelligence declaration")
			if err != nil {
				return nil, err
			}
		}
		declared := ncObject(campaign["intelligenceContract"])
		if declaration != nil {
			declared = ncObject(declaration["fields"])
		}
		relevant, workflowContracts, resourceWorkflows := []map[string]any{}, []map[string]any{}, []map[string]any{}
		for _, workflow := range workflows {
			if ncString(workflow["campaignId"]) == id {
				relevant = append(relevant, workflow)
			}
		}
		sort.Slice(relevant, func(i, j int) bool { return ncString(relevant[i]["id"]) < ncString(relevant[j]["id"]) })
		for _, workflow := range relevant {
			workflowID, err := ncRequired(workflow["id"], "workflow.id")
			if err != nil {
				return nil, err
			}
			contract := ncRecord{"workflowId": workflowID, "maxAiCredits": ncNumericEvidence(workflow["maxAiCredits"])}
			for _, field := range []string{"role", "state", "rolloutMode"} {
				contract[field], err = ncNullable(workflow[field], "workflow."+field)
				if err != nil {
					return nil, err
				}
			}
			workflowContracts = append(workflowContracts, contract)
			resourceWorkflows = append(resourceWorkflows, ncRecord{"workflowId": workflowID, "maxAiCredits": contract["maxAiCredits"]})
		}
		var explicitTargets any
		if len(ncArray(campaign["targets"])) > 0 {
			explicitTargets = campaign["targets"]
		}
		semantic := ncRecord{}
		for _, field := range ncSemanticFields {
			semantic[field] = declared[field]
		}
		if semantic["targetPopulation"] == nil {
			semantic["targetPopulation"] = explicitTargets
		}
		if semantic["resourceEnvelope"] == nil {
			semantic["resourceEnvelope"] = ncRecord{
				"monthlyAiCreditBudget": ncNumericEvidence(campaign["monthlyAiCreditBudget"]),
				"aiCreditAllowance":     ncNumericEvidence(campaign["aiCreditAllowance"]),
				"humanAttention":        ncRecord{"state": "missing", "value": nil}, "workflows": resourceWorkflows,
			}
		}
		fieldCount := 0
		for _, field := range ncSemanticFields {
			if semantic[field] != nil {
				fieldCount++
			}
		}
		provenance := []string{}
		observations := append([]map[string]any{campaign}, relevant...)
		for _, record := range observations {
			if source := ncObject(record["provenance"])["source"]; ncBool(source) {
				provenance = append(provenance, ncString(source))
			}
		}
		if declaration != nil {
			provenance = append(provenance, "campaign-intelligence-declaration")
		}
		completeness, provenanceState := "partial", "missing"
		if fieldCount == len(ncSemanticFields) {
			completeness = "complete"
		}
		if len(provenance) > 0 {
			provenanceState = "available"
		}
		quality := ncQuality(ncRecord{
			"availability": "available", "completeness": completeness,
			"freshness": ncRecord{"state": "unknown", "observedAt": ncLatest(observations, true)},
			"coverage":  ncRecord{"state": completeness, "numerator": fieldCount, "denominator": len(ncSemanticFields)},
			"maturity":  "unknown", "provenance": ncRecord{"state": provenanceState, "sources": provenance},
			"attributionCoverage": ncRecord{"state": "unknown", "numerator": nil, "denominator": nil},
			"contradictionState":  "unknown",
		})
		mode, err := ncNullable(campaign["mode"], "campaign.mode")
		if err != nil {
			return nil, err
		}
		slug, err := ncNullable(campaign["slug"], "campaign.slug")
		if err != nil {
			return nil, err
		}
		var enabled, declaredIdentity any
		if value, ok := campaign["enabled"].(bool); ok {
			enabled = value
		}
		if declaration != nil {
			declaredIdentity = ncRecord{"contractVersion": declaration["contractVersion"], "campaign": declaration["campaign"]}
		}
		contract := ncCopy(semantic)
		contract["contractId"], contract["contractVersion"] = ncID("campaign-intelligence-contract", ncRecord{"campaignId": id}), "1.1.0"
		contract["campaignId"], contract["campaignSlug"], contract["declaration"] = id, slug, declaredIdentity
		contract["authorityContext"] = ncRecord{
			"mode": mode, "enabled": enabled, "maxRepositories": ncNumericEvidence(campaign["maxRepositories"]),
			"rolloutPercent": ncNumericEvidence(campaign["rolloutPercent"]), "targets": explicitTargets,
		}
		contract["workflows"], contract["quality"] = workflowContracts, quality
		fingerprint := ncFingerprint(contract)
		contract["inputFingerprint"] = fingerprint
		contracts = append(contracts, contract)
	}
	sort.Slice(contracts, func(i, j int) bool {
		return ncString(contracts[i]["campaignId"]) < ncString(contracts[j]["campaignId"])
	})
	return contracts, nil
}

func ncFeedback(value any) ([]map[string]any, error) {
	records := []map[string]any{}
	if value == nil {
		return records, nil
	}
	object := ncObject(value)
	if object == nil || object["contractVersion"] != "1.0.0" || ncArray(object["records"]) == nil {
		return nil, nativeErrorf("Decision feedback must contain a supported contractVersion and records array")
	}
	if len(ncArray(object["records"])) > 1000 {
		return nil, nativeErrorf("Decision feedback must not exceed 1000 records")
	}
	dispositions := map[string]bool{"accepted": true, "rejected": true, "deferred": true, "superseded": true, "recovered": true, "expired": true, "unresolved": true}
	identities := map[string]bool{}
	for i, value := range ncArray(object["records"]) {
		input := ncObject(value)
		if input == nil {
			return nil, fmt.Errorf("feedback.records[%d] must be an object", i)
		}
		record := ncRecord{}
		prefix := fmt.Sprintf("feedback.records[%d].", i)
		for _, field := range []string{"decisionId", "inputFingerprint", "disposition", "observedAt"} {
			text, err := ncRequired(input[field], prefix+field)
			if err != nil {
				return nil, err
			}
			record[field] = text
		}
		if !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(ncString(record["inputFingerprint"])) {
			return nil, fmt.Errorf("%sinputFingerprint is invalid", prefix)
		}
		if !dispositions[ncString(record["disposition"])] {
			return nil, fmt.Errorf("%sdisposition is invalid", prefix)
		}
		stamp, ok := ncTime(record["observedAt"])
		if !ok {
			return nil, fmt.Errorf("%sobservedAt must be an ISO 8601 timestamp", prefix)
		}
		record["observedAt"] = stamp
		for _, field := range []string{"actor", "authority", "selectedAlternativeId", "rationale", "outcomeDisposition"} {
			text, err := ncNullable(input[field], prefix+field)
			if err != nil {
				return nil, err
			}
			if text != nil && len(utf16.Encode([]rune(ncString(text)))) > 4000 {
				return nil, fmt.Errorf("%s%s must not exceed 4000 characters", prefix, field)
			}
			record[field] = text
		}
		for _, field := range []string{"actualCost", "operationalValueMovement", "unexpectedEffects", "forecastAccuracy"} {
			record[field] = input[field]
		}
		record["feedbackId"] = ncID("decision-feedback", record)
		identity := ncString(record["decisionId"]) + "\x00" + ncString(record["inputFingerprint"]) + "\x00" + stamp
		if identities[identity] {
			return nil, nativeErrorf("Decision feedback contains duplicate decision, fingerprint, and timestamp records")
		}
		identities[identity] = true
		records = append(records, record)
	}
	ncSortFeedback(records)
	return records, nil
}

func ncSortFeedback(records []map[string]any) {
	sort.Slice(records, func(i, j int) bool {
		if records[i]["observedAt"] != records[j]["observedAt"] {
			return ncString(records[i]["observedAt"]) < ncString(records[j]["observedAt"])
		}
		return ncString(records[i]["feedbackId"]) < ncString(records[j]["feedbackId"])
	})
}
