package cli

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

func nativeTimestamp(value any) float64 {
	if timestamp, ok := engineParseDate(nativeScalar(value)); ok {
		return timestamp
	}
	return math.Inf(-1)
}

func nativeRecordTime(row map[string]any, fields []string) float64 {
	for _, field := range fields {
		if value := nativeTimestamp(row[field]); !math.IsInf(value, -1) {
			return value
		}
	}
	return math.Inf(-1)
}

func nativeWorkflowMatches(workflow map[string]any, value string) bool {
	if value == "" {
		return true
	}
	value = strings.ToLower(value)
	basename := path.Base(value)
	stem := basename
	if slices.Contains([]string{".md", ".yml", ".yaml"}, path.Ext(basename)) {
		stem = strings.TrimSuffix(basename, path.Ext(basename))
	}
	for _, field := range []string{"id", "name", "path"} {
		candidate := strings.ToLower(nativeText(workflow[field]))
		if candidate == "" {
			continue
		}
		base := path.Base(candidate)
		withoutExtension := base
		switch path.Ext(base) {
		case ".md", ".yml", ".yaml":
			withoutExtension = strings.TrimSuffix(base, path.Ext(base))
		}
		if slices.Contains([]string{candidate, base, withoutExtension}, value) ||
			slices.Contains([]string{candidate, base, withoutExtension}, basename) ||
			slices.Contains([]string{candidate, base, withoutExtension}, stem) {
			return true
		}
	}
	return false
}

func nativeGh(cmd *cobra.Command) (err error) {
	limit, err := nativeLimit(cmd, 30)
	if err != nil {
		return err
	}
	since, until := math.Inf(-1), math.Inf(1)
	for _, boundary := range []string{"since", "until"} {
		if value := nativeString(cmd, boundary); value != "" {
			timestamp := nativeTimestamp(value)
			if math.IsInf(timestamp, -1) {
				return fmt.Errorf("--%s must be a valid ISO 8601 time", boundary)
			}
			if boundary == "since" {
				since = timestamp
			} else {
				until = timestamp
				if len(value) == 10 {
					until += 24*60*60*1000 - 1
				}
			}
		}
	}
	if since > until {
		return fmt.Errorf("--since must not be later than --until")
	}
	db, err := openNativeSnapshot(nativeSnapshotPath(cmd))
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, db.Close()) }()
	collections := map[string][]map[string]any{}
	indexes := map[string]map[string]map[string]any{}
	for _, name := range []string{"repositories", "workflows", "runs", "issues"} {
		rows, err := readNativeCollection(cmd.Context(), db, name)
		if err != nil {
			return err
		}
		collections[name] = rows
		indexes[name] = map[string]map[string]any{}
		for _, row := range rows {
			indexes[name][nativeScalar(row["id"])] = row
		}
	}
	repositoryFilter := strings.ToLower(nativeString(cmd, "repo"))
	workflowFilter := nativeString(cmd, "workflow")
	statusFilter := strings.ToLower(nativeString(cmd, "status"))
	result := []map[string]any{}
	timestamps := []string{"startedAt", "createdAt", "updatedAt", "observedAt"}
	if cmd.Name() == "runs" {
		for _, run := range collections["runs"] {
			repository := indexes["repositories"][nativeScalar(run["repositoryId"])]
			workflow := indexes["workflows"][nativeScalar(run["workflowId"])]
			fullName := nativeText(repository["owner"]) + "/" + nativeText(repository["name"])
			if nativeText(repository["owner"]) == "" || nativeText(repository["name"]) == "" {
				fullName = nativeText(run["owner"]) + "/" + nativeText(run["repository"])
			}
			timestamp := nativeRecordTime(run, timestamps)
			if (repositoryFilter == "" || strings.ToLower(fullName) == repositoryFilter) &&
				nativeWorkflowMatches(workflow, workflowFilter) &&
				(statusFilter == "" || strings.EqualFold(nativeText(run["status"]), statusFilter) || strings.EqualFold(nativeText(run["conclusion"]), statusFilter)) &&
				timestamp >= since && timestamp <= until {
				result = append(result, run)
			}
		}
	} else {
		timestamps = []string{"createdAt"}
		isPR := cmd.Name() == "prs"
		outputType := "create_issue"
		if isPR {
			outputType = "create_pull_request"
		}
		for _, event := range collections["issues"] {
			if event["type"] != "safe_output.result" || event["isPullRequest"] != isPR || event["safeOutputType"] != outputType {
				continue
			}
			run := indexes["runs"][nativeScalar(event["runId"])]
			workflow := indexes["workflows"][nativeScalar(run["workflowId"])]
			repository := indexes["repositories"][nativeScalar(run["repositoryId"])]
			var targetRepository, link any
			var number any
			if parsed, err := url.Parse(nativeText(event["correlationId"])); err == nil && strings.EqualFold(parsed.Hostname(), "github.com") {
				parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
				if len(parts) >= 4 && parts[0] != "" && parts[1] != "" && (parts[2] == "issues" || parts[2] == "pull") {
					if n, err := strconv.Atoi(parts[3]); err == nil && n >= 0 && !strings.HasPrefix(parts[3], "+") {
						targetRepository, number, link = parts[0]+"/"+parts[1], n, event["correlationId"]
					}
				}
			}
			if targetRepository == nil {
				targetRepository = repository["fullName"]
			}
			workflowName := workflow["path"]
			if workflowName == nil {
				workflowName = workflow["name"]
			}
			createdAt := event["timestamp"]
			if createdAt == nil {
				createdAt = event["observedAt"]
			}
			record := map[string]any{"id": event["id"], "number": number, "repository": targetRepository,
				"workflow": workflowName, "workflowName": workflow["name"], "workflowId": workflow["id"],
				"createdAt": createdAt, "url": link, "type": event["safeOutputType"], "status": event["status"],
				"summary": event["summary"], "runId": run["id"], "githubRunId": run["githubRunId"]}
			timestamp := nativeRecordTime(record, timestamps)
			if (repositoryFilter == "" || strings.EqualFold(nativeScalar(targetRepository), repositoryFilter)) &&
				nativeWorkflowMatches(workflow, workflowFilter) && timestamp >= since && timestamp <= until {
				result = append(result, record)
			}
		}
	}
	slices.SortStableFunc(result, func(left, right map[string]any) int {
		a, b := nativeRecordTime(left, timestamps), nativeRecordTime(right, timestamps)
		if a > b {
			return -1
		}
		if a < b {
			return 1
		}
		return 0
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return printJSON(cmd, result)
}
