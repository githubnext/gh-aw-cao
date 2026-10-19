package localops

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode"
)

func (s *Service) selector(ctx context.Context, payload map[string]any) (any, error) {
	search := text(payload["text"])
	if !onlyKeys(payload, "id", "text") || len(strings.TrimSpace(search)) < 2 || len(search) > 200 || strings.IndexFunc(search, unicode.IsControl) >= 0 {
		return nil, failure(400, "Invalid selector request.")
	}
	action := actionByID(s.dashboard(), text(payload["id"]))
	selector := mapping(action["selector"])
	if selector == nil || action["copy-only"] == true {
		return nil, failure(404, "Dialog selector is not declared by this dashboard.")
	}
	query, mappingValue := mapping(selector["query"]), mapping(selector["mapping"])
	limit, err := number(query["limit"], 0, 1, 50)
	debounce, debounceErr := number(selector["debounce-ms"], 0, 100, 2000)
	_ = debounce
	if err != nil || debounceErr != nil || query["command"] != "gh search repos" || !onlyKeys(selector, "label", "placeholder", "debounce-ms", "query", "mapping") || !onlyKeys(query, "command", "fields", "limit") || !onlyKeys(mappingValue, "value", "label", "description", "target") || strings.TrimSpace(text(selector["label"])) == "" {
		return nil, failure(400, "Invalid dialog selector declaration.")
	}
	allowed := map[string]bool{"fullName": true, "description": true, "name": true, "owner": true, "url": true, "visibility": true, "isArchived": true, "isPrivate": true}
	fields := []string{}
	seen := map[string]bool{}
	for _, candidate := range array(query["fields"]) {
		field := text(candidate)
		if !allowed[field] || seen[field] {
			return nil, failure(400, "Invalid dialog selector fields.")
		}
		seen[field] = true
		fields = append(fields, field)
	}
	if len(fields) == 0 || !seen[text(mappingValue["value"])] || !seen[text(mappingValue["label"])] {
		return nil, failure(400, "Invalid dialog selector mapping.")
	}
	if description, present := mappingValue["description"]; present && !seen[text(description)] {
		return nil, failure(400, "Invalid dialog selector mapping.")
	}
	target := text(mappingValue["target"])
	valid := false
	for _, match := range templateToken.FindAllStringSubmatch(text(action["command"]), -1) {
		if match[1] == target && !isContextField(target) {
			valid = true
		}
	}
	if !valid || !identifier.MatchString(target) {
		return nil, failure(400, "Invalid dialog selector target.")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := readCommand(ctx, s.options, 256<<10, "search", "repos", "--limit", strconv.FormatInt(limit, 10), "--json", strings.Join(fields, ","), "--", strings.TrimSpace(search))
	if err != nil {
		return nil, failure(502, "Repository search failed. Check GitHub CLI authentication and try again.")
	}
	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil || int64(len(rows)) > limit {
		return nil, failure(502, "Repository search returned invalid results.")
	}
	options := []any{}
	for _, row := range rows {
		value, label := text(row[text(mappingValue["value"])]), text(row[text(mappingValue["label"])])
		description := ""
		if field := text(mappingValue["description"]); field != "" && row[field] != nil {
			var ok bool
			description, ok = row[field].(string)
			if !ok {
				return nil, failure(502, "Repository search returned an invalid mapped option.")
			}
		}
		if value == "" || label == "" || len(value) > 200 || len(label) > 2000 || len(description) > 8192 {
			return nil, failure(502, "Repository search returned an invalid mapped option.")
		}
		options = append(options, map[string]any{"value": value, "label": label, "description": description})
	}
	return map[string]any{"options": options}, nil
}
