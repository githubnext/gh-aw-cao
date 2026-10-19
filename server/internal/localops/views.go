package localops

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

const CustomViewsDirectory = ".cao/dashboard/custom-views"

type CustomView struct {
	ID       string         `json:"id"`
	Path     string         `json:"path"`
	Document map[string]any `json:"document"`
}

// ValidateCustomView admits only data-only, bounded, single-page documents.
func ValidateCustomView(raw []byte) (map[string]any, error) {
	if !utf8.Valid(raw) || utf8.RuneCount(raw) > 131072 || len(raw) > 160<<10 {
		return nil, errors.New("provide a Dashboard Language document of at most 131072 characters")
	}
	document := map[string]any{}
	if json.Unmarshal(raw, &document) != nil || document == nil || !onlyKeys(document, "language-version", "dashboard") || document["language-version"] != "0.1.0" {
		return nil, errors.New("invalid Dashboard Language document")
	}
	dashboard := mapping(document["dashboard"])
	if dashboard == nil || text(dashboard["id"]) == "" || text(dashboard["title"]) == "" {
		return nil, errors.New("dashboard identity and title are required")
	}
	if !onlyKeys(dashboard, "id", "title", "description", "defaults", "units", "queries", "card-templates", "pages", "subject", "objective", "acceptance") {
		return nil, errors.New("preview documents cannot declare actions, reusable views, callouts, navigation, or data status")
	}
	pages := array(dashboard["pages"])
	if len(pages) != 1 {
		return nil, errors.New("the query editor requires exactly one custom page")
	}
	page := mapping(pages[0])
	if page["kind"] != "custom" || page["id"] != "query-preview" {
		return nil, errors.New("use the isolated query-preview custom page")
	}
	for _, key := range []string{"route", "form", "pull-refresh", "retain-on-navigation"} {
		if _, present := page[key]; present {
			return nil, errors.New("preview pages cannot declare routing, forms, refresh, or retention controls")
		}
	}
	queries := array(dashboard["queries"])
	if len(queries) == 0 || len(queries) > 256 {
		return nil, errors.New("preview sources must be declared bounded queries")
	}
	definitionsRaw, _ := json.Marshal(queries)
	if _, err := query.ParseDefinitions(definitionsRaw); err != nil {
		return nil, fmt.Errorf("invalid preview queries: %w", err)
	}
	queryLimits := map[string]int64{}
	for _, candidate := range queries {
		q := mapping(candidate)
		limit, err := number(q["limit"], 0, 1, 200)
		if err != nil || q["limit"] == nil {
			return nil, errors.New("every preview query must declare query.limit from 1 through 200")
		}
		queryLimits[text(q["name"])] = limit
		if err := validateSemantic(q); err != nil {
			return nil, err
		}
	}
	for _, candidate := range array(dashboard["card-templates"]) {
		card := mapping(candidate)
		for _, key := range []string{"actions", "drill"} {
			if _, exists := card[key]; exists {
				return nil, errors.New("preview card templates cannot declare actions or drill navigation")
			}
		}
	}
	views := array(page["views"])
	if len(views) == 0 || len(views) > 200 {
		return nil, errors.New("preview pages require between one and 200 views")
	}
	for _, candidate := range views {
		view := mapping(candidate)
		if view == nil {
			return nil, errors.New("preview views must be mappings")
		}
		switch view["mark"] {
		case "metric", "table", "chart", "list":
		default:
			return nil, errors.New("preview views support only metric, table, chart, and list data marks")
		}
		for _, key := range []string{"element", "requires", "lazy-list", "card-drill"} {
			if _, exists := view[key]; exists {
				return nil, errors.New("preview views cannot declare elements, backend requirements, actions, drills, or lazy pagination")
			}
		}
		for _, key := range []string{"action", "drill", "view-all"} {
			if _, exists := mapping(view["list"])[key]; exists {
				return nil, errors.New("preview lists cannot declare actions or drill navigation")
			}
		}
		if _, exists := mapping(view["encoding"])["actions"]; exists {
			return nil, errors.New("preview views cannot declare actions")
		}
		data := mapping(view["data"])
		maximum := int64(200)
		if _, layered := view["layer"]; !layered {
			var err error
			maximum, err = number(data["limit"], 0, 1, 200)
			if err != nil || data["limit"] == nil {
				return nil, errors.New("each preview view must declare data.limit from 1 through 200")
			}
		}
		sources := []string{}
		if source := text(data["source"]); source != "" {
			sources = append(sources, source)
		}
		for _, source := range array(data["sources"]) {
			if text(source) == "" {
				return nil, errors.New("invalid preview source")
			}
			sources = append(sources, text(source))
		}
		for _, control := range array(mapping(view["filter-bar"])["filters"]) {
			for _, group := range array(mapping(control)["groups"]) {
				sources = append(sources, text(mapping(group)["source"]))
			}
		}
		if len(sources) == 0 {
			return nil, errors.New("every preview view must reference a declared bounded query")
		}
		for _, source := range sources {
			if queryLimits[source] < 1 || queryLimits[source] > maximum {
				return nil, errors.New("every preview source must be a declared query capped to data.limit (at most 200)")
			}
		}
		if err := validateSemantic(view); err != nil {
			return nil, err
		}
	}
	if err := rejectCapabilities(document, 0); err != nil {
		return nil, err
	}
	return document, nil
}
func rejectCapabilities(value any, depth int) error {
	if depth > 64 {
		return errors.New("preview document nesting exceeds limits")
	}
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			switch key {
			case "cli-actions", "actions", "action", "drill", "card-drill", "lazy-list", "element", "requires", "javascript", "script", "sql", "on-click":
				return errors.New("preview documents cannot declare executable capabilities or navigation actions")
			}
			if err := rejectCapabilities(item, depth+1); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range v {
			if err := rejectCapabilities(item, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}
func validateSemantic(value map[string]any) error {
	total := 0
	for _, key := range []string{"subject", "objective", "acceptance"} {
		if raw, present := value[key]; present {
			v, ok := raw.(string)
			if !ok {
				return errors.New("semantic metadata must be text")
			}
			total += utf8.RuneCountInString(v)
		}
	}
	if total > 512 {
		return errors.New("combined subject, objective, and acceptance must be at most 512 characters")
	}
	return nil
}
func customDirectory(workspace string, create bool) (string, error) {
	directory := workspace
	for _, segment := range strings.Split(CustomViewsDirectory, "/") {
		directory = filepath.Join(directory, segment)
		if create {
			if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
		}
		info, err := os.Lstat(directory)
		if !create && errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("local custom view storage must use workspace-owned directories, not symlinks")
		}
	}
	return directory, nil
}

var customFilename = regexp.MustCompile(`^local-[a-f0-9]{24}\.json$`)

func customID(raw []byte) string {
	hash := sha256.Sum256(raw)
	return "local-" + hex.EncodeToString(hash[:])[:24]
}
func LoadCustomViews(workspace string) ([]CustomView, error) {
	directory, err := customDirectory(workspace, false)
	if err != nil {
		return nil, err
	}
	result := []CustomView{}
	if directory == "" {
		return result, nil
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if customFilename.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) > 50 {
		return nil, errors.New("local custom view storage supports at most 50 views")
	}
	for _, name := range names {
		path := filepath.Join(directory, name)
		info, e := os.Lstat(path)
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 160<<10 {
			return nil, errors.New("invalid local custom view file")
		}
		raw, e := os.ReadFile(path) // #nosec G304 -- fixed content-addressed filename in validated non-symlink workspace directories.
		if e != nil {
			return nil, e
		}
		document, e := ValidateCustomView(raw)
		if e != nil {
			return nil, fmt.Errorf("invalid local custom view file %s: %w", name, e)
		}
		if name != customID(raw)+".json" {
			return nil, errors.New("local custom view identity does not match its document")
		}
		result = append(result, CustomView{strings.TrimSuffix(name, ".json"), path, document})
	}
	return result, nil
}
func serializeCustomView(raw []byte) ([]byte, error) {
	var value struct {
		LanguageVersion string          `json:"language-version"`
		Dashboard       json.RawMessage `json:"dashboard"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	compact, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var serialized bytes.Buffer
	if err = json.Indent(&serialized, compact, "", "  "); err != nil {
		return nil, err
	}
	_ = serialized.WriteByte('\n')
	return serialized.Bytes(), nil
}
func SaveCustomView(workspace string, raw []byte) (map[string]any, error) {
	if _, err := ValidateCustomView(raw); err != nil {
		return nil, failure(400, err.Error())
	}
	serialized, err := serializeCustomView(raw)
	if err != nil {
		return nil, err
	}
	id := customID(serialized)
	existing, err := LoadCustomViews(workspace)
	if err != nil {
		return nil, err
	}
	saved := map[string]any{"id": id, "path": CustomViewsDirectory + "/" + id + ".json"}
	for _, view := range existing {
		if view.ID == id {
			return saved, nil
		}
	}
	if len(existing) >= 50 {
		return nil, failure(409, "Local custom view storage supports at most 50 views.")
	}
	directory, err := customDirectory(workspace, true)
	if err != nil {
		return nil, err
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return nil, err
	}
	pending := filepath.Join(directory, ".pending-"+hex.EncodeToString(random))
	file, err := os.OpenFile(pending, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600) // #nosec G304 -- random exclusive filename in validated workspace-owned directory.
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(pending) }()
	_, writeErr := file.Write(serialized)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return nil, err
	}
	final := filepath.Join(directory, id+".json")
	if err = os.Link(pending, final); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		contents, e := os.ReadFile(final) // #nosec G304 -- content-addressed filename in validated non-symlink directory.
		if e != nil || !bytes.Equal(contents, serialized) {
			return nil, errors.New("custom view identity collision")
		}
	}
	return saved, nil
}

func MaterializeCustomView(document map[string]any, id string) map[string]any {
	raw, err := json.Marshal(document)
	if err != nil {
		return nil
	}
	result := map[string]any{}
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	dashboard := mapping(result["dashboard"])
	queries, cards, units, views := map[string]string{}, map[string]string{}, map[string]string{}, map[string]string{}
	for _, q := range array(dashboard["queries"]) {
		name := text(mapping(q)["name"])
		queries[name] = id + "-" + name
	}
	for _, card := range array(dashboard["card-templates"]) {
		name := text(mapping(card)["id"])
		cards[name] = id + "-" + name
	}
	for name := range mapping(dashboard["units"]) {
		units[name] = id + "-" + name
	}
	page := mapping(array(dashboard["pages"])[0])
	for _, v := range array(page["views"]) {
		if name := text(mapping(v)["id"]); name != "" {
			views[name] = id + "-" + name
		}
	}
	var rewrite func(any, string) any
	rewrite = func(value any, key string) any {
		switch v := value.(type) {
		case string:
			var names map[string]string
			switch key {
			case "from", "source", "sources", "union", "partial-source", "context-source", "summary-source":
				names = queries
			case "card":
				names = cards
			case "unit":
				names = units
			case "views":
				names = views
			}
			if name, exists := names[v]; exists {
				return name
			}
			return v
		case []any:
			for i, item := range v {
				v[i] = rewrite(item, key)
			}
			return v
		case map[string]any:
			for name, item := range v {
				v[name] = rewrite(item, name)
			}
			return v
		}
		return value
	}
	rewrite(result, "")
	dashboard["id"] = id
	page["id"] = id
	for _, q := range array(dashboard["queries"]) {
		m := mapping(q)
		m["name"] = queries[text(m["name"])]
	}
	for _, card := range array(dashboard["card-templates"]) {
		m := mapping(card)
		m["id"] = cards[text(m["id"])]
	}
	if definitions := mapping(dashboard["units"]); definitions != nil {
		renamed := map[string]any{}
		for name, value := range definitions {
			renamed[units[name]] = value
		}
		dashboard["units"] = renamed
	}
	for _, candidate := range array(page["views"]) {
		view := mapping(candidate)
		if name := text(view["id"]); name != "" {
			view["id"] = views[name]
		}
		if data := mapping(view["data"]); data != nil {
			for key, value := range mapping(dashboard["defaults"]) {
				if _, present := data[key]; !present {
					data[key] = value
				}
			}
		}
	}
	dashboard["navigation"] = []any{map[string]any{"label": "Custom views", "pages": []any{id}}}
	return result
}
