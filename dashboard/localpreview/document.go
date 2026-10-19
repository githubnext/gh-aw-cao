package localpreview

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/githubnext/gh-aw-cao/dashboard"
	"github.com/githubnext/gh-aw-cao/server/preview"
)

type object = map[string]any

func obj(value any) object {
	result, _ := value.(map[string]any)
	return result
}

func list(value any) []any {
	result, _ := value.([]any)
	return result
}

func text(value any) string {
	result, _ := value.(string)
	return result
}

func clone(value object) object {
	content, _ := json.Marshal(value)
	var result object
	_ = json.Unmarshal(content, &result)
	return result
}

type documentLoader struct {
	inputs map[string][]byte
}

func (l *documentLoader) read(name string) (object, error) {
	value, content, err := readObject(name)
	if err == nil {
		l.inputs[name] = content
	}
	return value, err
}

func (l *documentLoader) load(name string) (object, error) {
	name, err := filepath.EvalSymlinks(name)
	if err != nil {
		return nil, err
	}
	document, err := l.read(name)
	if err != nil {
		return nil, err
	}
	body := obj(document["dashboard"])
	if text(document["language-version"]) == "" || body == nil {
		return nil, errors.New("source is not a dashboard document")
	}
	root := filepath.Dir(name)
	seen := map[string]bool{}
	if fragments, present := document["fragments"]; present {
		if _, valid := fragments.([]any); !valid {
			return nil, errors.New("dashboard fragments must be relative path strings")
		}
		for _, fragment := range list(fragments) {
			candidate, err := regularFile(root, text(fragment))
			if err != nil {
				return nil, fmt.Errorf("load dashboard fragment: %w", err)
			}
			if seen[candidate] {
				return nil, errors.New("duplicate dashboard fragment")
			}
			seen[candidate] = true
			part, err := l.read(candidate)
			if err != nil {
				return nil, err
			}
			if _, nested := part["fragments"]; nested {
				return nil, errors.New("dashboard fragments cannot declare nested fragments")
			}
			if err := mergeFragment(body, part); err != nil {
				return nil, err
			}
		}
		delete(document, "fragments")
	}
	// A published site is already split. Hydrate its chunks before composing
	// campaigns or resplitting, so no built-in pages or query definitions vanish.
	for _, value := range list(body["pages"]) {
		page := obj(value)
		if page == nil {
			return nil, errors.New("dashboard pages must be objects")
		}
		if chunk := text(page["chunk"]); chunk != "" {
			candidate, err := regularFile(root, chunk)
			if err != nil {
				return nil, err
			}
			part, err := l.read(candidate)
			if err != nil {
				return nil, err
			}
			loaded := obj(part["page"])
			if loaded == nil || loaded["id"] != page["id"] {
				return nil, errors.New("dashboard page chunk identity does not match its page")
			}
			for key, value := range loaded {
				page[key] = value
			}
			for _, key := range []string{"chunk", "source-names", "lazy-source-names", "table-source-names", "independent-source-bindings", "backend-source-index"} {
				delete(page, key)
			}
			for _, candidate := range list(part["queries"]) {
				query := obj(candidate)
				if query == nil {
					return nil, errors.New("dashboard chunk queries must be objects")
				}
				found := false
				for _, existing := range list(body["queries"]) {
					old := obj(existing)
					if old != nil && old["name"] == query["name"] {
						before, _ := json.Marshal(old)
						after, _ := json.Marshal(query)
						if string(before) != string(after) {
							return nil, errors.New("dashboard chunks disagree on a query definition")
						}
						found = true
						break
					}
				}
				if !found {
					body["queries"] = append(list(body["queries"]), query)
				}
			}
		}
	}
	if err := validateDocument(document); err != nil {
		return nil, err
	}
	return document, nil
}

func mergeFragment(target, fragment object) error {
	for key, value := range fragment {
		if incoming, ok := value.([]any); ok {
			if old, exists := target[key]; exists {
				if _, ok := old.([]any); !ok {
					return fmt.Errorf("cannot append dashboard.%s to a non-array value", key)
				}
			}
			if key == "navigation" {
				if err := mergeNavigation(target, incoming); err != nil {
					return err
				}
			} else {
				target[key] = append(list(target[key]), incoming...)
			}
		} else {
			if _, exists := target[key]; exists {
				return fmt.Errorf("fragment duplicates dashboard.%s", key)
			}
			target[key] = value
		}
	}
	return nil
}

func mergeNavigation(target object, incoming []any) error {
	for _, value := range incoming {
		group := obj(value)
		if group == nil {
			return errors.New("dashboard navigation groups must be objects")
		}
		found := false
		for _, old := range list(target["navigation"]) {
			existing := obj(old)
			if existing != nil && existing["label"] == group["label"] {
				existing["pages"] = append(list(existing["pages"]), list(group["pages"])...)
				found = true
				break
			}
		}
		if !found {
			target["navigation"] = append(list(target["navigation"]), group)
		}
	}
	return nil
}

func composeDocuments(primary, addition object) error {
	if primary["language-version"] != addition["language-version"] {
		return errors.New("dashboard language version mismatch")
	}
	target, incoming := obj(primary["dashboard"]), obj(addition["dashboard"])
	for _, field := range []string{"pages", "queries", "cli-actions", "views", "card-templates", "callouts"} {
		target[field] = append(list(target[field]), list(incoming[field])...)
	}
	if units := obj(incoming["units"]); units != nil {
		existing := obj(target["units"])
		if existing == nil {
			existing = object{}
			target["units"] = existing
		}
		for name, value := range units {
			if _, exists := existing[name]; exists {
				return fmt.Errorf("duplicate dashboard unit: %s", name)
			}
			existing[name] = value
		}
	}
	return mergeNavigation(target, list(incoming["navigation"]))
}

func validateDocument(document object) error {
	body := obj(document["dashboard"])
	if text(document["language-version"]) == "" || body == nil || len(list(body["pages"])) == 0 {
		return errors.New("dashboard document requires a language version and pages")
	}
	for field, identity := range map[string]string{
		"pages": "id", "queries": "name", "cli-actions": "id", "views": "id", "card-templates": "id",
	} {
		if value, exists := body[field]; exists && value != nil {
			if _, valid := value.([]any); !valid {
				return fmt.Errorf("dashboard.%s must be an array", field)
			}
		}
		seen := map[string]bool{}
		for _, value := range list(body[field]) {
			entry := obj(value)
			name := text(entry[identity])
			if name == "" || seen[name] {
				return fmt.Errorf("dashboard.%s contains an empty or duplicate %s", field, identity)
			}
			seen[name] = true
			if field == "pages" {
				if text(entry["title"]) == "" {
					return errors.New("dashboard pages require a title")
				}
				kind := text(entry["kind"])
				if kind != "built-in" && kind != "custom" {
					return errors.New("dashboard page kind must be built-in or custom")
				}
				for _, property := range []string{"views", "sections"} {
					if value, exists := entry[property]; exists {
						if _, valid := value.([]any); !valid {
							return fmt.Errorf("dashboard page %s must be an array", property)
						}
					}
				}
			}
		}
	}
	return nil
}

func (w *Workspace) compose() (object, [32]byte, error) {
	loader := documentLoader{inputs: map[string][]byte{}}
	base, err := ownedPath(w.options.Workspace, w.base)
	if err != nil {
		return nil, [32]byte{}, err
	}
	document, err := loader.load(base)
	if err != nil {
		return nil, [32]byte{}, err
	}
	if w.catalog != "" {
		catalog, err := ownedPath(w.options.Workspace, w.catalog)
		if err != nil {
			return nil, [32]byte{}, err
		}
		entries, err := os.ReadDir(catalog)
		if err != nil {
			return nil, [32]byte{}, err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			if !entry.IsDir() {
				if entry.Type()&os.ModeSymlink == 0 {
					continue
				}
				info, err := os.Stat(filepath.Join(catalog, entry.Name()))
				if err != nil {
					return nil, [32]byte{}, err
				}
				if !info.IsDir() {
					continue
				}
			}
			name := filepath.Join(catalog, entry.Name(), "dashboard.json")
			if _, err := os.Stat(name); errors.Is(err, fs.ErrNotExist) {
				continue
			} else if err != nil {
				return nil, [32]byte{}, err
			}
			name, err = ownedPath(catalog, name)
			if err != nil {
				return nil, [32]byte{}, err
			}
			if name == w.base {
				continue
			}
			addition, err := loader.load(name)
			if err != nil {
				return nil, [32]byte{}, err
			}
			if err := composeDocuments(document, addition); err != nil {
				return nil, [32]byte{}, err
			}
		}
	}
	if w.options.Canvas {
		custom, err := preview.LoadCustomViews(w.options.Workspace)
		if err != nil {
			return nil, [32]byte{}, err
		}
		for _, view := range custom {
			addition := preview.MaterializeCustomView(view.Document, view.ID)
			if err := composeDocuments(document, addition); err != nil {
				return nil, [32]byte{}, err
			}
			content, _ := json.Marshal(view.Document)
			loader.inputs[view.ID] = content
		}
		content, err := dashboard.Site.ReadFile("site/canvas-query-editor.json")
		if err != nil {
			return nil, [32]byte{}, err
		}
		var editor object
		if err := json.Unmarshal(content, &editor); err != nil {
			return nil, [32]byte{}, err
		}
		if err := composeDocuments(document, editor); err != nil {
			return nil, [32]byte{}, err
		}
	}
	if w.options.Repository != "" {
		obj(document["dashboard"])["repository"] = w.options.Repository
	}
	if err := validateDocument(document); err != nil {
		return nil, [32]byte{}, err
	}
	names := make([]string, 0, len(loader.inputs))
	for name := range loader.inputs {
		names = append(names, name)
	}
	sort.Strings(names)
	hash := sha256.New()
	for _, name := range names {
		hash.Write([]byte(name))
		hash.Write([]byte{0})
		hash.Write(loader.inputs[name])
		hash.Write([]byte{0})
	}
	var signature [32]byte
	copy(signature[:], hash.Sum(nil))
	return document, signature, nil
}

// SaveDashboard validates and persists a single isolated custom view, then
// immediately refreshes the active dashboard. Saving an existing view is safe.
func (w *Workspace) SaveDashboard(ctx context.Context, document []byte) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !w.options.Canvas {
		return nil, errors.New("custom view authoring requires canvas mode")
	}
	saved, err := preview.SaveCustomView(w.options.Workspace, document)
	if err != nil {
		return nil, err
	}
	content, err := w.Refresh()
	if err != nil {
		return nil, err
	}
	saved["dashboard"] = json.RawMessage(content)
	return saved, nil
}

func viewSources(view object) []string {
	data := obj(view["data"])
	names := []string{}
	if source := text(data["source"]); source != "" {
		names = append(names, source)
	}
	for _, source := range list(data["sources"]) {
		if name := text(source); name != "" {
			names = append(names, name)
		}
	}
	for _, filter := range list(obj(view["filter-bar"])["filters"]) {
		for _, group := range list(obj(filter)["groups"]) {
			if name := text(obj(group)["source"]); name != "" {
				names = append(names, name)
			}
		}
	}
	return unique(names)
}

func unique(names []string) []string {
	result := []string{}
	for _, name := range names {
		if name != "" && !slices.Contains(result, name) {
			result = append(result, name)
		}
	}
	return result
}

func pageViews(page, dashboard object) ([]object, []any) {
	body := page
	if page["kind"] == "built-in" {
		body = obj(page["definition"])
	}
	reusable := map[string]object{}
	for _, candidate := range list(dashboard["views"]) {
		view := obj(candidate)
		reusable[text(view["id"])] = view
	}
	views := []object{}
	for _, candidate := range list(body["views"]) {
		view := obj(candidate)
		if name, isName := candidate.(string); isName {
			view = reusable[name]
		}
		if view != nil {
			views = append(views, view)
		}
	}
	return views, list(body["sections"])
}

func queryDependencies(dashboard object, sources []string) []any {
	index := map[string]object{}
	for _, candidate := range list(dashboard["queries"]) {
		query := obj(candidate)
		index[text(query["name"])] = query
	}
	needed := map[string]bool{}
	var visit func(string)
	visit = func(name string) {
		if name == "" || needed[name] {
			return
		}
		needed[name] = true
		query := index[name]
		visit(text(query["from"]))
		for _, input := range list(query["union"]) {
			visit(text(input))
		}
		for _, join := range list(query["joins"]) {
			visit(text(obj(join)["source"]))
		}
	}
	for _, name := range sources {
		visit(name)
	}
	result := []any{}
	for _, candidate := range list(dashboard["queries"]) {
		if needed[text(obj(candidate)["name"])] {
			result = append(result, candidate)
		}
	}
	return result
}

func sourceIndex(views []object, sections []any, backend string, callouts []string, async map[string]bool) object {
	sources, lazy, tables := []string{}, []string{}, []string{}
	for _, view := range views {
		if backend != "" {
			if requirement, exists := view["requires"]; exists && obj(requirement)["backend"] != backend {
				continue
			}
		}
		if !async[text(view["element"])] {
			sources = append(sources, viewSources(view)...)
		}
		data := viewSources(object{"data": view["data"]})
		if view["lazy-list"] == true {
			lazy = append(lazy, data...)
		}
		if view["mark"] == "table" {
			tables = append(tables, data...)
		}
	}
	for _, candidate := range sections {
		section := obj(candidate)
		sources = append(sources, text(section["count-source"]))
		for _, name := range list(section["count-sources"]) {
			sources = append(sources, text(name))
		}
	}
	return object{
		"sourceNames":      unique(append(sources, callouts...)),
		"lazySourceNames":  unique(lazy),
		"tableSourceNames": unique(tables),
	}
}

func splitDocument(source object) (object, map[string][]byte, error) {
	document := clone(source)
	body := obj(document["dashboard"])
	chunks := map[string][]byte{}
	pages := []any{}
	calloutSources := []string{}
	for _, candidate := range list(body["callouts"]) {
		calloutSources = append(calloutSources, text(obj(obj(candidate)["visible-when"])["source"]))
	}
	indicators := []string{}
	for _, candidate := range list(body["pages"]) {
		for _, name := range list(obj(obj(candidate)["navigation-indicator"])["any"]) {
			indicators = append(indicators, text(name))
		}
	}
	async := map[string]bool{"factory-header": true, "factory-floor": true, "all-campaign-memory": true, "link-button-list": true, "measure-history": true}
	for _, candidate := range list(body["pages"]) {
		page := obj(candidate)
		views, sections := pageViews(page, body)
		sourceNames := []string{}
		allNames := append([]string{}, indicators...)
		lazyNames, tableNames := []string{}, []string{}
		sourceBacked, independentlyBound := 0, true
		for _, view := range views {
			names := viewSources(view)
			allNames = append(allNames, names...)
			allNames = append(allNames, text(obj(view["data"])["partial-source"]))
			if len(names) != 0 {
				sourceBacked++
				if !async[text(view["element"])] {
					independentlyBound = false
				}
			}
			if !async[text(view["element"])] {
				sourceNames = append(sourceNames, names...)
			}
			if view["lazy-list"] == true {
				lazyNames = append(lazyNames, viewSources(object{"data": view["data"]})...)
			}
			if view["mark"] == "table" {
				tableNames = append(tableNames, viewSources(object{"data": view["data"]})...)
			}
		}
		for _, section := range sections {
			entry := obj(section)
			if name := text(entry["count-source"]); name != "" {
				sourceNames = append(sourceNames, name)
				independentlyBound = false
			}
			for _, name := range list(entry["count-sources"]) {
				sourceNames = append(sourceNames, text(name))
				independentlyBound = false
			}
		}
		sourceNames = unique(append(sourceNames, calloutSources...))
		allNames = unique(append(allNames, sourceNames...))
		chunk := object{"page": page, "queries": queryDependencies(body, allNames)}
		content, err := json.Marshal(chunk)
		if err != nil {
			return nil, nil, err
		}
		digest := sha256.Sum256(content)
		// Immutable chunk URLs make the final dashboard.json rename the only
		// publication point. Existing browser requests keep a coherent revision.
		name := fmt.Sprintf("dashboard-pages/%x/%s.json", digest[:8], url.PathEscape(text(page["id"])))
		chunks[name] = content
		stub := clone(page)
		stub["chunk"] = name
		stub["source-names"], stub["lazy-source-names"], stub["table-source-names"] = sourceNames, unique(lazyNames), unique(tableNames)
		stub["independent-source-bindings"] = sourceBacked > 0 && independentlyBound
		for _, view := range views {
			if _, conditional := view["requires"]; conditional {
				stub["backend-source-index"] = object{
					"static": sourceIndex(views, sections, "static", calloutSources, async),
					"hosted": sourceIndex(views, sections, "hosted", calloutSources, async),
				}
				break
			}
		}
		for _, key := range []string{"intent", "subject", "objective", "acceptance"} {
			delete(stub, key)
		}
		if page["kind"] == "built-in" {
			delete(stub, "definition")
		} else {
			delete(stub, "views")
			delete(stub, "sections")
		}
		pages = append(pages, stub)
	}
	status := obj(body["data-status"])
	shellSources := append(calloutSources, text(status["freshness-source"]), text(status["health-source"]))
	shellQueries := queryDependencies(body, shellSources)
	if len(shellQueries) == 0 {
		delete(body, "queries")
	} else {
		body["queries"] = shellQueries
	}
	body["pages"] = pages
	return document, chunks, nil
}

var secretKey = regexp.MustCompile(`(?i)(?:^|[-_])(api[-_]?key|authorization|client[-_]?secret|password|private[-_]?key|secret|token)(?:$|[-_])`)
var secretValues = []*regexp.Regexp{
	regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`),
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*`),
	regexp.MustCompile(`\bAKIA[A-Z0-9]{16}\b`),
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
}

func redact(value any, key string) any {
	if secretKey.MatchString(key) {
		return "[REDACTED]"
	}
	switch entry := value.(type) {
	case string:
		for _, pattern := range secretValues {
			entry = pattern.ReplaceAllString(entry, "[REDACTED]")
		}
		return entry
	case []any:
		result := make([]any, len(entry))
		for i, item := range entry {
			result[i] = redact(item, "")
		}
		return result
	case map[string]any:
		result := object{}
		for name, item := range entry {
			result[name] = redact(item, name)
		}
		return result
	default:
		return value
	}
}
