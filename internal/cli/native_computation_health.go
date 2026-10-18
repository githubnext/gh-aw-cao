package cli

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

func ncRunDate(run ncRecord) any {
	for _, field := range []string{"runDate", "startedAt", "createdAt", "updatedAt"} {
		if date, ok := ncTime(run[field]); ok {
			return date
		}
	}
	return nil
}

func ncRunReference(run ncRecord) ncRecord {
	id := ncOptional(run["id"])
	if id == nil {
		runID := "undefined"
		if value, exists := run["githubRunId"]; exists {
			runID = ncString(value)
		}
		id = fmt.Sprintf("github:run:%s:attempt:%s", runID, ncString(ncDefault(run["attempt"], 1)))
	}
	reference := ncRecord{
		"runId": id, "githubRunId": run["githubRunId"], "attempt": ncNumber(ncDefault(run["attempt"], 1)),
		"status": ncDefault(ncOptional(run["status"]), "unknown"), "conclusion": ncOptional(run["conclusion"]),
		"observedAt": run["runDate"], "url": ncOptional(run["runLink"]),
	}
	if _, exists := run["githubRunId"]; !exists {
		delete(reference, "githubRunId")
	}
	return reference
}

func ncRunNewer(left, right ncRecord) bool {
	a, b := ncString(left["runDate"]), ncString(right["runDate"])
	if a != b {
		return a > b
	}
	a, b = ncString(left["githubRunId"]), ncString(right["githubRunId"])
	if a != b {
		a, b = strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
		if len(a) != len(b) {
			return len(a) > len(b)
		}
		if a != b {
			return a > b
		}
	}
	return ncNumber(left["attempt"]) > ncNumber(right["attempt"])
}

func ncCompare(left, right any) int {
	if left == nil || left == "" {
		if right == nil || right == "" {
			return 0
		}
		return 1
	}
	if right == nil || right == "" {
		return -1
	}
	a, b := ncNumber(strings.ReplaceAll(ncString(left), ",", "")), ncNumber(strings.ReplaceAll(ncString(right), ",", ""))
	if !math.IsNaN(a) && !math.IsNaN(b) && !math.IsInf(a, 0) && !math.IsInf(b, 0) {
		if a < b {
			return -1
		}
		if a > b {
			return 1
		}
		return 0
	}
	if a, ok := ncTime(left); ok {
		if b, ok := ncTime(right); ok {
			return strings.Compare(a, b)
		}
	}
	return strings.Compare(ncString(left), ncString(right))
}

func ncOrderedRuns(runs []map[string]any, byTarget bool) ([]map[string]any, error) {
	result := append([]map[string]any{}, runs...)
	date := func(run ncRecord) any { return ncCoalesce(run["startedAt"], run["createdAt"], run["updatedAt"]) }
	sort.SliceStable(result, func(i, j int) bool {
		left, right := result[i], result[j]
		if byTarget {
			if comparison := ncCompare(left["targetRepository"], right["targetRepository"]); comparison != 0 {
				return comparison < 0
			}
		}
		for _, values := range [][2]any{{date(left), date(right)}, {left["githubRunId"], right["githubRunId"]}, {left["attempt"], right["attempt"]}} {
			if comparison := ncCompare(values[0], values[1]); comparison != 0 {
				return comparison > 0
			}
		}
		return false
	})
	if !byTarget {
		if err := ncValidateRunOrder(result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// The query's timestamp is its declared coalesced source fact; the measure
// checks its own fallback date and refuses contradictory partition order.
func ncValidateRunOrder(runs []map[string]any) error {
	var previous ncRecord
	for _, run := range runs {
		current := ncCopy(run)
		current["runDate"] = ncRunDate(current)
		if current["runDate"] == nil {
			continue
		}
		if previous != nil && ncRunNewer(current, previous) {
			return fmt.Errorf("partition.runs must be ordered newest-first by run date, GitHub run ID, and attempt")
		}
		previous = current
	}
	return nil
}

func ncPartition(campaign, workflow ncRecord, runs []map[string]any, target, membership any) ncRecord {
	ordered, unknown := []map[string]any{}, []map[string]any{}
	for _, run := range runs {
		copy := ncCopy(run)
		copy["runDate"] = ncRunDate(run)
		if copy["runDate"] == nil {
			unknown = append(unknown, copy)
		} else {
			ordered = append(ordered, copy)
		}
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ncRunNewer(ordered[i], ordered[j]) })
	since, failures := []map[string]any{}, []map[string]any{}
	var success ncRecord
	visited, active := 0, 0
	for _, run := range ordered {
		visited++
		if run["conclusion"] == "success" {
			success = run
			break
		}
		since = append(since, run)
		if run["status"] == "completed" {
			failures = append(failures, run)
		}
		switch run["status"] {
		case "queued", "in_progress", "waiting", "requested", "pending":
			active++
		}
	}
	answer := "unknown"
	switch {
	case len(runs) == 0:
		answer = "not-observed"
	case len(unknown) > 0 && len(ordered) == 0:
		answer = "unknown"
	case len(failures) > 0:
		answer = "no"
	case active > 0:
		answer = "running"
	case success != nil:
		answer = "yes"
	}
	errors := map[string][]map[string]any{}
	for _, run := range failures {
		key := "unknown-error"
		for _, field := range []string{"failureKind", "classification", "conclusion"} {
			if value := strings.ToLower(strings.TrimSpace(ncString(run[field]))); value != "" {
				key = value
				break
			}
		}
		errors[key] = append(errors[key], run)
	}
	groups := []map[string]any{}
	for key, rows := range errors {
		counts, seen := ncRecord{}, map[string]bool{}
		jobs, steps, refs := []string{}, []string{}, []map[string]any{}
		for i, run := range rows {
			ref := ncRunReference(run)
			seen[ncString(ref["runId"])] = true
			conclusion := ncString(ncDefault(ncOptional(run["conclusion"]), "unknown"))
			counts[conclusion] = int(ncNumber(counts[conclusion])) + 1
			if v := strings.TrimSpace(ncString(run["failureJob"])); v != "" {
				jobs = append(jobs, v)
			}
			if v := strings.TrimSpace(ncString(run["failureStep"])); v != "" {
				steps = append(steps, v)
			}
			if i < 20 {
				refs = append(refs, ref)
			}
		}
		groups = append(groups, ncRecord{
			"errorKey": key, "count": len(rows), "distinctRunAttemptCount": len(seen), "conclusionCounts": counts,
			"latestObservedAt": rows[0]["runDate"], "failureJobs": ncUnique(jobs, 20), "failureSteps": ncUnique(steps, 20),
			"runReferences": refs, "omittedRunReferenceCount": max(0, len(rows)-20), "runReferenceLimit": 20,
		})
	}
	sort.Slice(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		if a["count"] != b["count"] {
			return ncNumber(a["count"]) > ncNumber(b["count"])
		}
		if a["latestObservedAt"] != b["latestObservedAt"] {
			return ncString(a["latestObservedAt"]) > ncString(b["latestObservedAt"])
		}
		return ncString(a["errorKey"]) < ncString(b["errorKey"])
	})
	groupCount := len(groups)
	groups = groups[:min(len(groups), 20)]
	unknownRefs := []map[string]any{}
	for _, run := range unknown[:min(len(unknown), 20)] {
		unknownRefs = append(unknownRefs, ncRunReference(run))
	}
	var latestRef, successRef any
	if len(ordered) > 0 {
		latestRef = ncRunReference(ordered[0])
	}
	boundary := "not-observed"
	if success != nil {
		successRef, boundary = ncRunReference(success), "observed"
	}
	kind := "orchestrator"
	if workflow["role"] == "worker" {
		kind = "worker-target"
	}
	result := ncRecord{
		"measureId": "runtime-health", "measureVersion": "1.0.0", "campaignId": campaign["id"],
		"workflowId": workflow["id"], "workflowRole": workflow["role"], "workflowState": ncDefault(ncOptional(workflow["state"]), "unknown"),
		"partitionKind": kind, "answer": answer, "needsAttention": answer == "no" || answer == "unknown" || answer == "not-observed",
		"evidenceQuality": nil, "latestRun": latestRef, "latestSuccess": successRef, "successBoundary": boundary,
		"runsSinceSuccess": len(since), "terminalNonSuccessesSinceSuccess": len(failures), "activeRunsSinceSuccess": active,
		"unknownDateRunCount": len(unknown), "unknownDateRunReferences": unknownRefs,
		"omittedUnknownDateRunReferenceCount": max(0, len(unknown)-20), "recoveryMayBeInProgress": len(failures) > 0 && active > 0,
		"recordsVisited": visited, "partitionRunCount": len(runs), "errorGroupCount": groupCount,
		"errorGroups": groups, "omittedErrorGroupCount": max(0, groupCount-20), "errorGroupLimit": 20,
	}
	if workflow["role"] == "worker" {
		result["targetRepositoryId"], result["targetScopeMembership"] = target, membership
	}
	return result
}

func ncWorkerGate(orchestrators []map[string]any) string {
	if len(orchestrators) == 0 {
		return "indeterminate-orchestrator"
	}
	unknown := false
	for _, partition := range orchestrators {
		if partition["answer"] == "no" {
			return "blocked-by-orchestrator"
		}
		if partition["answer"] == "unknown" || partition["answer"] == "not-observed" {
			unknown = true
		}
	}
	if unknown {
		return "indeterminate-orchestrator"
	}
	return "eligible"
}

func ncAggregateAnswer(results []map[string]any) string {
	answers := map[string]bool{}
	for _, result := range results {
		answers[ncString(result["answer"])] = true
	}
	switch {
	case answers["no"]:
		return "no"
	case answers["unknown"]:
		return "unknown"
	case len(answers) == 1 && answers["not-observed"]:
		return "not-observed"
	case answers["not-observed"]:
		return "unknown"
	case answers["running"]:
		return "running"
	case len(answers) == 1 && answers["yes"]:
		return "yes"
	default:
		return "unknown"
	}
}

func ncRuntimeHealth(data ncData, slug string) (ncRecord, error) {
	campaigns := []map[string]any{}
	for _, campaign := range data.campaigns {
		if slug == "" || campaign["slug"] == slug {
			campaigns = append(campaigns, campaign)
		}
	}
	if slug != "" && len(campaigns) == 0 {
		return nil, nativeErrorf("Unknown campaign: %s", slug)
	}
	sort.Slice(campaigns, func(i, j int) bool { return ncString(campaigns[i]["id"]) < ncString(campaigns[j]["id"]) })
	repositories := map[string]string{}
	for _, repository := range data.repositories {
		name := ncString(repository["fullName"])
		if name == "" && ncBool(repository["owner"]) && ncBool(repository["name"]) {
			name = ncString(repository["owner"]) + "/" + ncString(repository["name"])
		}
		if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
			repositories[name] = ncString(repository["id"])
		}
	}
	targetID := func(name string) any {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			return nil
		}
		if id, ok := repositories[name]; ok {
			return id
		}
		return "repository:" + ncEncode(name)
	}
	campaignResults, partitions, errorGroups := []map[string]any{}, []map[string]any{}, []map[string]any{}
	runsByWorkflow := map[string][]map[string]any{}
	for _, run := range data.runs {
		runsByWorkflow[ncString(run["workflowId"])] = append(runsByWorkflow[ncString(run["workflowId"])], run)
	}
	for _, campaign := range campaigns {
		workflows := []map[string]any{}
		for _, workflow := range data.workflows {
			if workflow["campaignId"] == campaign["id"] && (workflow["role"] == "worker" || workflow["role"] == "orchestrator") {
				workflows = append(workflows, workflow)
			}
		}
		sort.Slice(workflows, func(i, j int) bool {
			if workflows[i]["role"] != workflows[j]["role"] {
				return ncString(workflows[i]["role"]) < ncString(workflows[j]["role"])
			}
			return ncString(workflows[i]["id"]) < ncString(workflows[j]["id"])
		})
		orchestrators := []map[string]any{}
		for _, workflow := range workflows {
			if workflow["role"] == "orchestrator" {
				runs, err := ncOrderedRuns(runsByWorkflow[ncString(workflow["id"])], false)
				if err != nil {
					return nil, err
				}
				orchestrators = append(orchestrators, ncPartition(campaign, workflow, runs, nil, nil))
			}
		}
		gate := ncWorkerGate(orchestrators)
		expected := map[string]bool{}
		for _, target := range ncArray(campaign["targets"]) {
			name := ncString(target)
			if object := ncObject(target); object != nil {
				name = ncString(object["repository"])
			}
			if id := targetID(name); id != nil {
				expected[ncString(id)] = true
			}
		}
		workers := []map[string]any{}
		if gate == "eligible" {
			for _, workflow := range workflows {
				if workflow["role"] != "worker" {
					continue
				}
				runs, err := ncOrderedRuns(runsByWorkflow[ncString(workflow["id"])], true)
				if err != nil {
					return nil, err
				}
				byTarget, order := map[string][]map[string]any{}, []string{}
				for _, run := range runs {
					id := ncString(targetID(ncString(run["targetRepository"])))
					if _, exists := byTarget[id]; !exists {
						order = append(order, id)
					}
					byTarget[id] = append(byTarget[id], run)
				}
				for _, id := range order {
					if err := ncValidateRunOrder(byTarget[id]); err != nil {
						return nil, err
					}
					membership := "unknown"
					if id != "" && expected[id] {
						membership = "expected"
					} else if id != "" && len(expected) > 0 {
						membership = "observed-extra"
					}
					workers = append(workers, ncPartition(campaign, workflow, byTarget[id], ncOptional(id), membership))
				}
			}
		}
		included := append([]map[string]any{}, orchestrators...)
		for _, worker := range workers {
			if worker["targetScopeMembership"] != "observed-extra" {
				included = append(included, worker)
			}
		}
		answer := ncAggregateAnswer(included)
		switch gate {
		case "blocked-by-orchestrator":
			answer = "no"
		case "indeterminate-orchestrator":
			answer = "unknown"
		}
		all := append(append([]map[string]any{}, orchestrators...), workers...)
		attention, visited, runCount := 0, 0, 0
		for _, partition := range included {
			if ncBool(partition["needsAttention"]) {
				attention++
			}
		}
		for _, partition := range all {
			visited += int(ncNumber(partition["recordsVisited"]))
			runCount += int(ncNumber(partition["partitionRunCount"]))
			for _, group := range ncRows(partition["errorGroups"]) {
				copy := ncRecord{"campaignId": campaign["id"], "workflowId": partition["workflowId"], "workflowRole": partition["workflowRole"]}
				for _, field := range []string{"targetRepositoryId", "targetScopeMembership"} {
					if value, exists := partition[field]; exists {
						copy[field] = value
					}
				}
				for key, value := range group {
					copy[key] = value
				}
				errorGroups = append(errorGroups, copy)
			}
		}
		campaignResults = append(campaignResults, ncRecord{
			"measureId": "runtime-health", "measureVersion": "1.0.0", "campaignId": campaign["id"],
			"answer": answer, "workerEvaluationState": gate, "orchestratorCount": len(orchestrators),
			"workerPartitionCount": len(workers), "attentionPartitionCount": attention,
			"recordsVisited": visited, "partitionRunCount": runCount, "skippedWorkerPartitionCount": 0, "skippedWorkerRunCount": 0,
		})
		partitions = append(partitions, all...)
	}
	return ncRecord{"measureId": "runtime-health", "measureVersion": "1.0.0", "campaignResults": campaignResults, "partitionResults": partitions, "errorGroups": errorGroups}, nil
}

var ncRuntimeFields = []string{"ghAwVersion", "engine", "engineVersion", "agentVersion", "requestedModel", "resolvedModel", "firewallVersion"}

func ncSelect(record ncRecord, fields []string) ncRecord {
	result := ncRecord{}
	for _, field := range fields {
		result[field] = record[field]
	}
	return result
}

func ncPartitionKey(record ncRecord) string {
	return ncString(record["campaignId"]) + "\x00" + ncString(record["workflowId"]) + "\x00" + ncString(record["targetRepositoryId"])
}

func ncDiagnostics(result ncRecord, data ncData) ncRecord {
	partitions, runs := map[string]ncRecord{}, map[string]ncRecord{}
	for _, partition := range ncRows(result["partitionResults"]) {
		partitions[ncPartitionKey(partition)] = partition
	}
	for _, run := range data.runs {
		runs[ncString(run["id"])] = run
	}
	metadata := append([]string{"id", "githubRunId", "attempt", "startedAt", "completedAt", "duration", "status", "conclusion", "failureKind", "classification", "targetRepository", "rolloutMode"}, ncRuntimeFields...)
	metadata = append(metadata, "firewallAllowedCalls", "firewallBlockedCalls", "mcpToolCalls", "highPriorityAuditItems", "mediumPriorityAuditItems", "errorCount", "runLink")
	failures := []map[string]any{}
	groups := ncRows(result["errorGroups"])
	for _, group := range groups[:min(len(groups), 5)] {
		partition := partitions[ncPartitionKey(group)]
		failed, rawFailed := []map[string]any{}, []map[string]any{}
		refs := ncRows(group["runReferences"])
		for _, ref := range refs[:min(len(refs), 5)] {
			if run := runs[ncString(ref["runId"])]; run != nil {
				rawFailed = append(rawFailed, run)
				failed = append(failed, ncSelect(run, metadata))
			}
		}
		var latestFailure, success ncRecord
		if len(rawFailed) > 0 {
			latestFailure = rawFailed[0]
		}
		if reference := ncObject(partition["latestSuccess"]); reference != nil {
			success = runs[ncString(reference["runId"])]
		}
		changes := ncRecord{}
		if latestFailure != nil && success != nil {
			for _, field := range ncRuntimeFields {
				if latestFailure[field] != success[field] {
					changes[field] = ncRecord{"failed": latestFailure[field], "latestSuccess": success[field]}
				}
			}
		}
		evidence, omitted := ncRecord{}, ncRecord{}
		for _, selection := range []struct {
			name   string
			rows   []map[string]any
			fields []string
		}{
			{"audits", data.audits, []string{"id", "runId", "timestamp", "observedAt", "source", "type", "status", "summary", "error"}},
			{"toolErrors", data.tools, []string{"id", "runId", "timestamp", "observedAt", "type", "status", "summary", "mcpServer", "mcpTool"}},
			{"firewallBlocks", data.domains, []string{"id", "runId", "timestamp", "observedAt", "domain", "decision", "requestCount"}},
			{"safeOutputs", data.issues, []string{"id", "runId", "timestamp", "observedAt", "type", "status", "summary", "safeOutputType", "correlationId"}},
		} {
			matches := []map[string]any{}
			for _, record := range selection.rows {
				if latestFailure == nil || ncString(record["runId"]) != ncString(latestFailure["id"]) {
					continue
				}
				if selection.name == "toolErrors" && record["status"] != "error" && record["status"] != "rate-limited" {
					continue
				}
				if selection.name == "firewallBlocks" && record["decision"] != "blocked" {
					continue
				}
				matches = append(matches, record)
			}
			sort.Slice(matches, func(i, j int) bool {
				a := ncString(ncDefault(matches[i]["timestamp"], matches[i]["observedAt"]))
				b := ncString(ncDefault(matches[j]["timestamp"], matches[j]["observedAt"]))
				if a != b {
					return a > b
				}
				return ncString(matches[i]["id"]) < ncString(matches[j]["id"])
			})
			selected := []map[string]any{}
			for _, row := range matches[:min(len(matches), 20)] {
				selected = append(selected, ncSelect(row, selection.fields))
			}
			evidence[selection.name], omitted[selection.name] = selected, max(0, len(matches)-20)
		}
		var selectedSuccess, actions any
		if success != nil {
			selectedSuccess = ncSelect(success, metadata)
		}
		if ncBool(latestFailure["runLink"]) {
			actions = ncRecord{"url": latestFailure["runLink"], "reason": "Canonical evidence does not contain the exact process error; inspect job logs and stderr."}
		}
		failures = append(failures, ncRecord{
			"errorGroup": group, "failedRuns": failed, "omittedFailedRunCount": max(0, int(ncNumber(group["count"]))-len(failed)),
			"latestSuccess": selectedSuccess, "changedRuntimeFields": changes, "evidence": evidence, "omittedEvidence": omitted, "actionsRun": actions,
		})
	}
	return ncRecord{"groupLimit": 5, "omittedGroupCount": max(0, len(groups)-5), "failures": failures}
}
