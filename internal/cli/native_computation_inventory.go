package cli

import (
	"fmt"
	"sort"
	"strings"
)

func ncEncode(value string) string {
	var encoded strings.Builder
	for _, char := range []byte(value) {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("-_.!~*'()", rune(char)) {
			encoded.WriteByte(char)
		} else {
			fmt.Fprintf(&encoded, "%%%02X", char)
		}
	}
	return encoded.String()
}

func ncInventory(value any) (ncData, error) {
	data := ncData{}
	sources := ncObject(value)
	if sources == nil {
		return data, nativeErrorf("Computation inventory must be an object containing source documents")
	}
	for _, names := range [][]string{{"campaigns", "packages"}, {"repositories"}, {"workflows"}, {"runs"}, {"domains"}, {"tools"}, {"skills"}, {"friction"}, {"audits"}, {"issues"}, {"marketplace-packages"}} {
		for _, name := range names {
			source, exists := sources[name]
			if !exists {
				continue
			}
			metadata := ncObject(ncObject(source)["metadata"])
			if metadata["availability"] == "unavailable" {
				message, ok := metadata["error"].(string)
				if !ok {
					message = "$" + names[0] + " is unavailable"
				}
				return data, fmt.Errorf("%s", message)
			}
			break
		}
	}
	for _, kind := range []string{"campaigns", "repositories", "workflows"} {
		source, exists := sources[kind]
		if kind == "campaigns" && !exists {
			source = sources["packages"]
		}
		document := ncObject(source)
		metadata := ncObject(document["metadata"])
		if metadata["availability"] == "unavailable" {
			message, ok := metadata["error"].(string)
			if !ok {
				message = "$" + kind + " is unavailable"
			}
			return data, fmt.Errorf("%s", message)
		}
		observations := []map[string]any{}
		for _, row := range ncRows(document["rows"]) {
			observedAt := ncCoalesce(row["observed-at"], ncDefault(metadata["as-of"], metadata["retrieved-at"]))
			stamp, valid := ncTime(observedAt)
			if !valid {
				return data, fmt.Errorf("%s.observed-at must be a valid timestamp", kind)
			}
			record := ncRecord{"observedAt": stamp}
			sourceID := ""
			switch kind {
			case "campaigns":
				slug := strings.TrimSpace(ncString(ncCoalesce(row["campaign"], row["package"])))
				if slug == "" {
					return data, fmt.Errorf("campaign.slug is required")
				}
				sourceID = slug
				record["id"], record["slug"] = "campaign:dashboard-sources:"+ncEncode(slug), slug
				fields := []struct {
					name, suffix string
					fallback     any
				}{
					{"name", "name", slug}, {"description", "description", ""}, {"icon", "icon", "goal"},
					{"mode", "mode", "unknown"}, {"enabled", "enabled", true},
					{"maxRepositories", "max-repositories", nil}, {"rolloutPercent", "rollout-percent", nil},
					{"monthlyAiCreditBudget", "monthly-ai-credit-budget", nil}, {"aiCreditAllowance", "aic-allowance", nil},
					{"workerCount", "worker-count", 0}, {"inventoryWarnings", "inventory-warnings", 0},
					{"workers", "workers", []any{}}, {"targets", "targets", []any{}},
					{"intelligenceDeclaration", "intelligence-declaration", nil},
					{"minVersion", "min-version", ""}, {"version", "version", "unknown"},
					{"currentVersion", "current-version", "unknown"}, {"updateState", "update-state", "unknown"},
					{"experimental", "experimental", nil}, {"readmePath", "readme-path", ""}, {"readme", "readme", ""},
					{"campaignLink", "link", nil},
				}
				for _, field := range fields {
					record[field.name] = ncDefault(row["campaign-"+field.suffix], ncDefault(row["package-"+field.suffix], field.fallback))
					if record[field.name] == "" {
						record[field.name] = field.fallback
					}
				}
				record["enabled"] = record["enabled"] != false
				record["experimental"] = record["experimental"] == true
			case "repositories", "workflows":
				owner, repository := strings.TrimSpace(ncString(row["organization"])), strings.TrimSpace(ncString(row["repository"]))
				if owner == "" || repository == "" {
					return data, fmt.Errorf("%s organization and repository are required", kind)
				}
				coordinate := strings.ToLower(owner + "/" + repository)
				if kind == "repositories" {
					sourceID = owner + "/" + repository
					record["id"], record["owner"], record["name"] = "repository:"+ncEncode(coordinate), owner, repository
				} else {
					path := strings.ToLower(strings.TrimSpace(ncString(row["workflow"])))
					if strings.HasSuffix(path, ".lock.yml") {
						path = strings.TrimSuffix(path, ".lock.yml") + ".md"
					}
					if path == "" {
						return data, fmt.Errorf("workflow.path is required")
					}
					sourceID = coordinate + ":" + path
					record["id"] = "workflow:" + ncEncode(sourceID)
					record["repositoryId"], record["path"] = "repository:"+ncEncode(coordinate), path
					slug := strings.TrimSpace(ncString(ncCoalesce(row["campaign"], row["package"])))
					record["campaignId"] = nil
					if slug != "" {
						record["campaignId"] = "campaign:dashboard-sources:" + ncEncode(slug)
					}
					record["state"] = "unknown"
					switch row["workflow-active"] {
					case "true":
						record["state"] = "active"
					case "false":
						record["state"] = "disabled"
					}
					for key, source := range map[string]string{
						"role": "workflow-role", "rolloutMode": "rollout-mode", "maxAiCredits": "max-ai-credits",
					} {
						if v, ok := row[source]; ok {
							record[key] = v
						}
					}
				}
			}
			record["provenance"] = ncRecord{"source": "dashboard-sources", "sourceId": sourceID, "observedAt": stamp}
			observations = append(observations, record)
		}
		sort.SliceStable(observations, func(i, j int) bool {
			left, right := observations[i], observations[j]
			if left["observedAt"] != right["observedAt"] {
				return ncString(left["observedAt"]) < ncString(right["observedAt"])
			}
			a, b := ncString(ncObject(left["provenance"])["sourceId"]), ncString(ncObject(right["provenance"])["sourceId"])
			if a != b {
				return a < b
			}
			return string(ncCanonicalJSON(left)) < string(ncCanonicalJSON(right))
		})
		rows := ncMerge(nil, observations)
		sort.Slice(rows, func(i, j int) bool { return ncString(rows[i]["id"]) < ncString(rows[j]["id"]) })
		switch kind {
		case "campaigns":
			data.campaigns = rows
		case "workflows":
			data.workflows = rows
		case "repositories":
			data.repositories = rows
		}
	}
	return data, nil
}
