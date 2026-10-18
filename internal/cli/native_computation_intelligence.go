package cli

import (
	"sort"
	"strings"
)

func ncSignals(health ncRecord) []map[string]any {
	partitions := map[string]ncRecord{}
	for _, partition := range ncRows(health["partitionResults"]) {
		partitions[ncPartitionKey(partition)] = partition
	}
	signals := []map[string]any{}
	for _, group := range ncRows(health["errorGroups"]) {
		target := ncOptional(group["targetRepositoryId"])
		identity := ncRecord{
			"measureId": "runtime-health", "campaignId": ncString(group["campaignId"]),
			"workflowId": ncString(group["workflowId"]), "targetRepositoryId": target, "errorKey": ncString(group["errorKey"]),
		}
		references := []string{}
		for _, ref := range ncRows(group["runReferences"]) {
			if id := strings.TrimSpace(ncString(ref["runId"])); id != "" {
				references = append(references, id)
			}
		}
		partition := partitions[ncPartitionKey(group)]
		var observed any
		if value, ok := group["latestObservedAt"].(string); ok {
			observed = value
		}
		signal := ncRecord{
			"signalId": ncID("runtime-health-signal", identity), "measureId": "runtime-health", "measureVersion": health["measureVersion"],
			"campaignId": identity["campaignId"], "workflowId": identity["workflowId"],
			"workflowRole":       ncString(ncDefault(group["workflowRole"], ncDefault(partition["workflowRole"], "unknown"))),
			"targetRepositoryId": target, "targetScopeMembership": ncOptional(group["targetScopeMembership"]),
			"errorKey": identity["errorKey"], "failureCount": ncNumber(group["count"]),
			"distinctRunAttemptCount": ncNumber(group["distinctRunAttemptCount"]), "observedAt": observed,
			"recoveryMayBeInProgress": ncBool(partition["recoveryMayBeInProgress"]), "evidenceReferences": ncUnique(references, 50),
		}
		fingerprint := ncFingerprint(signal)
		signal["inputFingerprint"] = fingerprint
		signals = append(signals, signal)
	}
	sort.Slice(signals, func(i, j int) bool { return ncString(signals[i]["signalId"]) < ncString(signals[j]["signalId"]) })
	return signals
}

func ncSuppression(signal ncRecord, rule, reconsideration string, related any) ncRecord {
	return ncRecord{
		"suppressionId": ncID("suppression", ncRecord{"signalId": signal["signalId"], "rule": rule, "relatedDecisionId": related}),
		"rule":          rule, "signalId": signal["signalId"], "inputFingerprint": signal["inputFingerprint"],
		"subject":           ncRecord{"campaignId": signal["campaignId"], "workflowId": signal["workflowId"], "targetRepositoryId": signal["targetRepositoryId"]},
		"relatedDecisionId": related, "nextReconsideration": reconsideration,
	}
}

func ncDecisionIdentity(signals []map[string]any) ncRecord {
	return ncRecord{
		"decisionClass": "protect", "subject": ncRecord{"campaignId": signals[0]["campaignId"]},
		"operation": "investigate-runtime-failure", "correlationKey": ncString(signals[0]["campaignId"]) + "\x00" + ncString(signals[0]["errorKey"]),
	}
}

func ncDecision(signals []map[string]any, fingerprint string, contract ncRecord, feedback any) ncRecord {
	workflows, targets, references := []string{}, []string{}, []string{}
	failures, attempts, attributed := 0.0, 0.0, 0
	inputs := []map[string]any{}
	for _, signal := range signals {
		workflows = append(workflows, ncString(signal["workflowId"]))
		if ncBool(signal["targetRepositoryId"]) {
			targets = append(targets, ncString(signal["targetRepositoryId"]))
		}
		for _, ref := range ncArray(signal["evidenceReferences"]) {
			references = append(references, ncString(ref))
		}
		failures += ncNumber(signal["failureCount"])
		attempts += ncNumber(signal["distinctRunAttemptCount"])
		if signal["targetRepositoryId"] != nil {
			attributed++
		}
		inputs = append(inputs, ncRecord{"signalId": signal["signalId"], "inputFingerprint": signal["inputFingerprint"]})
	}
	state, attributionState := "decide-soon", "partial"
	if failures >= 3 {
		state = "act-now"
	}
	if attributed == len(signals) {
		attributionState = "complete"
	}
	references = ncUnique(references, 0)
	provenanceState, sources := "missing", []string{"runtime-health"}
	if len(references) > 0 {
		provenanceState = "available"
	}
	var contractIdentity any
	if contract != nil {
		sources = append(sources, "campaign-intelligence-contract")
		contractIdentity = ncRecord{"contractId": contract["contractId"], "inputFingerprint": contract["inputFingerprint"]}
	}
	quality := ncQuality(ncRecord{
		"availability": "available", "completeness": ncDefault(ncObject(contract["quality"])["completeness"], "partial"),
		"freshness":           ncRecord{"state": "unknown", "observedAt": ncLatest(signals, false)},
		"coverage":            ncRecord{"state": "partial", "numerator": len(signals), "denominator": nil},
		"maturity":            ncDefault(ncObject(contract["quality"])["maturity"], "unknown"),
		"provenance":          ncRecord{"state": provenanceState, "sources": sources},
		"attributionCoverage": ncRecord{"state": attributionState, "numerator": attributed, "denominator": len(signals)},
		"contradictionState":  "unknown",
	})
	quality["correlationRule"], quality["evidenceReferenceCount"] = "exact-campaign-and-runtime-error-key", len(references)
	if len(references) > 50 {
		references = references[:50]
	}
	return ncRecord{
		"measureId": "portfolio-decisions", "measureVersion": "1.2.0",
		"decisionId": ncID("runtime-health-decision", ncDecisionIdentity(signals)), "inputFingerprint": fingerprint,
		"decisionClass": "protect", "state": state,
		"subject":        ncRecord{"campaignId": signals[0]["campaignId"], "workflowIds": ncUnique(workflows, 0), "targetRepositoryIds": ncUnique(targets, 0)},
		"recommendation": ncRecord{"operation": "investigate-runtime-failure", "errorKey": signals[0]["errorKey"], "mode": "review", "dispatchable": false},
		"alternatives": []map[string]any{
			{"id": "defer", "action": "defer", "condition": "Wait for another canonical runtime observation."},
			{"id": "do-nothing", "action": "do-nothing", "consequence": "The observed failure condition remains unresolved."},
			{"id": "obtain-additional-evidence", "action": "obtain-additional-evidence", "evidence": "Inspect the referenced workflow runs and bounded diagnostics."},
		},
		"hardGates":    []map[string]any{{"id": "execution-authority", "status": "not-evaluated", "effect": "dispatch-prohibited"}},
		"consequences": ncRecord{"affectedPartitionCount": len(signals), "observedFailureCount": failures, "distinctRunAttemptCount": attempts},
		"forecast":     ncRecord{"method": "observed-recurrence", "probability": nil, "note": "No model-generated probability is used."},
		"quality":      quality, "sensitivity": []map[string]any{{"parameter": "actNowFailureCount", "value": 3, "currentState": state}},
		"capacityRequirements": []any{},
		"correlationGroup":     ncRecord{"key": ncString(signals[0]["campaignId"]) + "\x00" + ncString(signals[0]["errorKey"]), "rule": "exact-campaign-and-runtime-error-key", "signalCount": len(signals)},
		"evidenceReferences":   references, "campaignContract": contractIdentity, "feedback": feedback,
		"decisionTrace": ncRecord{
			"inputs": inputs, "measureVersions": ncRecord{"runtime-health": signals[0]["measureVersion"], "portfolio-decisions": "1.2.0"},
			"rules":       []string{"correlate exact campaign and runtime error key", "exclude observed targets outside declared scope", "suppress while recovery may be in progress", "preserve review-only advisory output"},
			"gates":       []string{"execution authority is not evaluated"},
			"assumptions": []string{"runtime-health error keys identify the same underlying condition"},
			"thresholds":  ncRecord{"actNowFailureCount": 3}, "excludedAlternatives": []any{}, "capacityConstraints": []any{},
			"tieBreakers": []string{"decision state priority", "decisionId lexical order"},
		},
		"computedAt": ncLatest(signals, false),
	}
}

func ncIntelligence(health ncRecord, allContracts []map[string]any, previous, supplied any) (ncRecord, error) {
	var prior ncRecord
	if previous != nil {
		prior = ncObject(previous)
		if prior["command"] == "computation" {
			prior = ncObject(prior["result"])
		}
		if prior == nil {
			return nil, nativeErrorf("Previous intelligence result must be an object")
		}
		if prior["measureId"] != "portfolio-decisions" || prior["measureVersion"] != "1.2.0" || ncArray(prior["decisions"]) == nil {
			return nil, nativeErrorf("Previous intelligence result has an incompatible contract")
		}
		for _, value := range ncArray(prior["decisions"]) {
			decision := ncObject(value)
			_, idOK := decision["decisionId"].(string)
			_, fingerprintOK := decision["inputFingerprint"].(string)
			if decision == nil || !idOK || !fingerprintOK {
				return nil, nativeErrorf("Previous intelligence result contains an invalid Decision")
			}
		}
	}
	previousFeedback, err := ncFeedback(prior["feedback"])
	if err != nil {
		return nil, err
	}
	suppliedFeedback, err := ncFeedback(supplied)
	if err != nil {
		return nil, err
	}
	feedbackByID := map[string]ncRecord{}
	for _, rows := range [][]map[string]any{previousFeedback, suppliedFeedback} {
		for _, record := range rows {
			feedbackByID[ncString(record["feedbackId"])] = record
		}
	}
	feedback := []map[string]any{}
	for _, record := range feedbackByID {
		feedback = append(feedback, record)
	}
	ncSortFeedback(feedback)
	evaluated := map[string]bool{}
	for _, campaign := range ncRows(health["campaignResults"]) {
		evaluated[ncString(campaign["campaignId"])] = true
	}
	contracts, byCampaign := []map[string]any{}, map[string]ncRecord{}
	for _, contract := range allContracts {
		if evaluated[ncString(contract["campaignId"])] {
			contracts = append(contracts, contract)
			byCampaign[ncString(contract["campaignId"])] = contract
		}
	}
	signals := ncSignals(health)
	suppressions, decisions := []map[string]any{}, []map[string]any{}
	groups := map[string][]map[string]any{}
	for _, signal := range signals {
		if signal["targetScopeMembership"] == "observed-extra" {
			suppressions = append(suppressions, ncSuppression(signal, "outside-declared-target-scope", "Reconsider when the repository is explicitly enrolled.", nil))
		} else if ncBool(signal["recoveryMayBeInProgress"]) {
			suppressions = append(suppressions, ncSuppression(signal, "recovery-in-progress", "Reconsider after the active run reaches a terminal state.", nil))
		} else {
			key := ncString(signal["campaignId"]) + "\x00" + ncString(signal["errorKey"])
			groups[key] = append(groups[key], signal)
		}
	}
	groupKeys := []string{}
	for key := range groups {
		groupKeys = append(groupKeys, key)
	}
	sort.Strings(groupKeys)
	priorDecisions := map[string]ncRecord{}
	for _, decision := range ncRows(prior["decisions"]) {
		priorDecisions[ncString(decision["decisionId"])] = decision
	}
	reused := []string{}
	currentIDs, appliedIDs, staleIDs := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, key := range groupKeys {
		group := groups[key]
		contract := byCampaign[ncString(group[0]["campaignId"])]
		refs := []map[string]any{}
		for _, signal := range group {
			refs = append(refs, ncRecord{"signalId": signal["signalId"], "inputFingerprint": signal["inputFingerprint"]})
		}
		fingerprint := ncFingerprint(ncRecord{
			"measureId": "portfolio-decisions", "measureVersion": "1.2.0", "actNowFailureCount": 3,
			"campaignContractFingerprint": contract["inputFingerprint"], "signals": refs,
		})
		id := ncID("runtime-health-decision", ncDecisionIdentity(group))
		currentIDs[id] = true
		var matched ncRecord
		for _, record := range feedback {
			if record["decisionId"] != id {
				continue
			}
			if record["inputFingerprint"] != fingerprint {
				staleIDs[ncString(record["feedbackId"])] = true
			} else {
				matched = record
			}
		}
		var matchingFeedback any
		if matched != nil {
			appliedIDs[ncString(matched["feedbackId"])] = true
			matchingFeedback = matched
		}
		candidate := ncDecision(group, fingerprint, contract, matchingFeedback)
		switch matched["disposition"] {
		case "accepted", "rejected", "superseded", "recovered", "expired":
			suppressions = append(suppressions, ncSuppression(group[0], "unchanged-terminal-result", "Reconsider when the input fingerprint changes.", id))
			continue
		}
		if priorDecisions[id]["inputFingerprint"] == fingerprint {
			reused = append(reused, id)
		}
		decisions = append(decisions, candidate)
	}
	sort.Slice(decisions, func(i, j int) bool {
		if decisions[i]["state"] != decisions[j]["state"] {
			return decisions[i]["state"] == "act-now"
		}
		return ncString(decisions[i]["decisionId"]) < ncString(decisions[j]["decisionId"])
	})
	sort.Slice(suppressions, func(i, j int) bool {
		return ncString(suppressions[i]["suppressionId"]) < ncString(suppressions[j]["suppressionId"])
	})
	sort.Strings(reused)
	stale, unmatched := []string{}, []string{}
	for id := range staleIDs {
		stale = append(stale, id)
	}
	for _, record := range feedback {
		if !currentIDs[ncString(record["decisionId"])] {
			unmatched = append(unmatched, ncString(record["feedbackId"]))
		}
	}
	sort.Strings(stale)
	sort.Strings(unmatched)
	completeness, coverageState, provenanceState := "missing", "missing", "missing"
	sources := []string{"runtime-health"}
	if len(contracts) > 0 {
		completeness, coverageState = "complete", "partial"
		for _, contract := range contracts {
			if ncObject(contract["quality"])["completeness"] != "complete" {
				completeness = "partial"
			}
		}
		sources = append(sources, "campaign-intelligence-contract")
	}
	if len(signals) > 0 {
		provenanceState = "available"
	}
	evidence := ncQuality(ncRecord{
		"availability": "available", "completeness": completeness,
		"freshness": ncRecord{"state": "unknown", "observedAt": ncLatest(signals, false)},
		"coverage":  ncRecord{"state": coverageState, "numerator": len(contracts), "denominator": nil},
		"maturity":  "unknown", "provenance": ncRecord{"state": provenanceState, "sources": sources},
		"attributionCoverage": ncRecord{"state": "unknown", "numerator": nil, "denominator": nil}, "contradictionState": "unknown",
	})
	signalFingerprints, contractFingerprints, feedbackIDs := []string{}, []string{}, []string{}
	for _, signal := range signals {
		signalFingerprints = append(signalFingerprints, ncString(signal["inputFingerprint"]))
	}
	for _, contract := range contracts {
		contractFingerprints = append(contractFingerprints, ncString(contract["inputFingerprint"]))
	}
	for _, record := range feedback {
		feedbackIDs = append(feedbackIDs, ncString(record["feedbackId"]))
	}
	return ncRecord{
		"measureId": "portfolio-decisions", "measureVersion": "1.2.0",
		"inputFingerprint": ncFingerprint(ncRecord{"runtimeHealthMeasureVersion": health["measureVersion"], "signalFingerprints": signalFingerprints, "campaignContractFingerprints": contractFingerprints, "feedbackIds": feedbackIDs, "actNowFailureCount": 3}),
		"evidenceQuality":  evidence, "evaluatedDecisionClasses": []string{"protect"}, "agentInvocations": 0,
		"campaignContractCount": len(contracts), "campaignContracts": contracts,
		"feedback": ncRecord{
			"contractId": "decision-feedback", "contractVersion": "1.0.0", "recordCount": len(feedback),
			"appliedCount": len(appliedIDs), "staleCount": len(staleIDs), "unmatchedCount": len(unmatched),
			"staleFeedbackIds": stale, "unmatchedFeedbackIds": unmatched, "records": feedback,
		},
		"signalCount": len(signals), "correlatedCandidateCount": len(groups), "decisionCount": len(decisions),
		"suppressionCount": len(suppressions), "reusedDecisionIds": reused, "decisions": decisions, "suppressions": suppressions,
		"asOf": ncLatest(signals, false),
	}, nil
}
