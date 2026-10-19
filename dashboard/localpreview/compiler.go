package localpreview

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var compilerSemver = regexp.MustCompile(`^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
var numericVersionPart = regexp.MustCompile(`^[0-9]+$`)
var workflowCoordinate = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9_.-]{1,100}$`)
var compilerWorkflowPath = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}(?:\.md|\.lock\.yml)$`)
var compilerMetadataLine = regexp.MustCompile(`(?m)^# gh-aw-metadata: (.+)$`)
var gitObjectID = regexp.MustCompile(`(?i)^[a-f0-9]{40,64}$`)

type compilerVersion struct {
	parts      []string
	prerelease []string
	normalized string
}

func parseCompilerVersion(value string) *compilerVersion {
	match := compilerSemver.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return nil
	}
	version := &compilerVersion{parts: match[1:4], normalized: "v" + strings.Join(match[1:4], ".")}
	if match[4] != "" {
		version.prerelease = strings.Split(match[4], ".")
		for _, part := range version.prerelease {
			if numericVersionPart.MatchString(part) && len(part) > 1 && part[0] == '0' {
				return nil
			}
		}
		version.normalized += "-" + match[4]
	}
	return version
}

func compareNumericVersion(left, right string) int {
	left, right = strings.TrimLeft(left, "0"), strings.TrimLeft(right, "0")
	if len(left) != len(right) {
		if len(left) < len(right) {
			return -1
		}
		return 1
	}
	return strings.Compare(left, right)
}

func compilerUpdateState(installed, latest string) string {
	left, right := parseCompilerVersion(installed), parseCompilerVersion(latest)
	if left == nil || right == nil {
		return "unknown"
	}
	comparison := 0
	for index := range left.parts {
		if comparison = compareNumericVersion(left.parts[index], right.parts[index]); comparison != 0 {
			break
		}
	}
	if comparison == 0 {
		if len(left.prerelease) == 0 && len(right.prerelease) > 0 {
			comparison = 1
		} else if len(left.prerelease) > 0 && len(right.prerelease) == 0 {
			comparison = -1
		} else {
			for index := 0; index < max(len(left.prerelease), len(right.prerelease)); index++ {
				if index >= len(left.prerelease) {
					comparison = -1
					break
				}
				if index >= len(right.prerelease) {
					comparison = 1
					break
				}
				a, b := left.prerelease[index], right.prerelease[index]
				aNumeric, bNumeric := numericVersionPart.MatchString(a), numericVersionPart.MatchString(b)
				switch {
				case aNumeric && bNumeric:
					comparison = compareNumericVersion(a, b)
				case aNumeric != bNumeric:
					comparison = 1
					if aNumeric {
						comparison = -1
					}
				default:
					comparison = strings.Compare(a, b)
				}
				if comparison != 0 {
					break
				}
			}
		}
	}
	if comparison < 0 {
		return "update-available"
	}
	return "up-to-date"
}

func compilerRows(sources object) ([]any, error) {
	workflows, exists := sources["workflows"]
	if !exists {
		return nil, nil
	}
	rows, valid := obj(workflows)["rows"].([]any)
	if !valid {
		return nil, errors.New("dashboard workflow inventory does not contain source rows")
	}
	for _, row := range rows {
		if obj(row) == nil {
			return nil, errors.New("dashboard workflow inventory rows must be objects")
		}
	}
	return rows, nil
}

// RefreshCompilerRelease preserves installed compiler evidence and observation
// times, updating only the latest stable release and its comparison state.
func RefreshCompilerRelease(sources object, latest string) (object, error) {
	version := parseCompilerVersion(latest)
	if version == nil || len(version.prerelease) != 0 {
		return nil, errors.New("GitHub returned an invalid latest stable gh-aw release")
	}
	result := clone(sources)
	rows, err := compilerRows(result)
	if err != nil {
		return nil, err
	}
	for _, value := range rows {
		row := obj(value)
		row["gh-aw-current-version"] = version.normalized
		row["gh-aw-update-state"] = compilerUpdateState(text(row["gh-aw-version"]), version.normalized)
	}
	return result, nil
}

type compilerResponse struct {
	status  int
	warning string
	version string
}

type compilerReader func(context.Context, string) (compilerResponse, error)

func compilerResourcePath(row object) string {
	organization, repository := text(row["organization"]), text(row["repository"])
	coordinate := organization + "/" + repository
	workflow := strings.TrimPrefix(text(row["workflow"]), ".github/workflows/")
	if !workflowCoordinate.MatchString(coordinate) || repository == "." || repository == ".." || !compilerWorkflowPath.MatchString(workflow) {
		return ""
	}
	if strings.HasSuffix(workflow, ".md") {
		workflow = strings.TrimSuffix(workflow, ".md") + ".lock.yml"
	}
	return "repos/" + coordinate + "/contents/.github/workflows/" + workflow
}

func refreshCompilerVersions(ctx context.Context, sources object, request compilerReader) (object, error) {
	result := clone(sources)
	rows, err := compilerRows(result)
	if err != nil {
		return nil, err
	}
	paths := make([]string, len(rows))
	pending, requested := []string{}, map[string]bool{}
	for index, value := range rows {
		path := compilerResourcePath(obj(value))
		paths[index] = path
		if path != "" && !requested[path] {
			pending = append(pending, path)
			requested[path] = true
		}
	}
	versions := map[string]string{}
	var mutex sync.Mutex
	for index := 0; index < min(len(pending), 128); index += 8 {
		var group sync.WaitGroup
		for _, path := range pending[index:min(index+8, len(pending), 128)] {
			group.Go(func() {
				response, err := request(ctx, path)
				version := parseCompilerVersion(response.version)
				if err == nil && response.status == 200 && response.warning == "" && version != nil {
					mutex.Lock()
					versions[path] = version.normalized
					mutex.Unlock()
				}
			})
		}
		group.Wait()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	for index, value := range rows {
		if paths[index] == "" {
			continue
		}
		row := obj(value)
		row["gh-aw-update-state"] = "unknown"
		if version := versions[paths[index]]; version != "" {
			row["gh-aw-version"] = version
			row["gh-aw-update-state"] = compilerUpdateState(version, text(row["gh-aw-current-version"]))
		}
	}
	return result, nil
}

func readCompilerResponse(content []byte, resourcePath string) (compilerResponse, error) {
	response := compilerResponse{status: 200}
	if len(content) > 512<<10 {
		return response, errors.New("compiler metadata exceeds the file-size limit")
	}
	if bytes.HasPrefix(content, []byte("HTTP/")) {
		reader := textproto.NewReader(bufio.NewReader(bytes.NewReader(content)))
		status, err := reader.ReadLine()
		if err != nil {
			return response, err
		}
		var protocol string
		if _, err := fmt.Sscanf(status, "%s %d", &protocol, &response.status); err != nil {
			return response, err
		}
		headers, err := reader.ReadMIMEHeader()
		if err != nil {
			return response, err
		}
		response.warning = headers.Get("Warning")
		content, err = io.ReadAll(reader.R)
		if err != nil {
			return response, err
		}
	}
	var file struct {
		Type, Path, SHA, Encoding, Content string
	}
	if err := json.Unmarshal(content, &file); err != nil {
		return response, err
	}
	_, expected, found := strings.Cut(resourcePath, "/contents/")
	if !found || file.Type != "file" || file.Path != expected || file.Encoding != "base64" || !gitObjectID.MatchString(file.SHA) {
		return response, errors.New("GitHub returned an invalid compiler resource")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(file.Content, "\n", ""))
	if err != nil {
		return response, err
	}
	match := compilerMetadataLine.FindSubmatch(decoded)
	var metadata struct {
		Version string `json:"compiler_version"`
	}
	if len(match) != 2 || json.Unmarshal(match[1], &metadata) != nil {
		return response, errors.New("workflow lock contains no compiler metadata")
	}
	response.version = metadata.Version
	return response, nil
}

func canonicalCompilerOverrides(ctx context.Context, databasePath, latest string) (object, error) {
	version := parseCompilerVersion(latest)
	if version == nil || len(version.prerelease) != 0 {
		return nil, errors.New("GitHub returned an invalid latest stable gh-aw release")
	}
	dsn := url.URL{Scheme: "file", Path: databasePath, RawQuery: "mode=ro"}
	database, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	defer func() { _ = database.Close() }()
	rows, err := database.QueryContext(ctx, `SELECT record_key,value FROM __idb_records
		WHERE (database_name='gh-aw-cao-dashboard-data' OR database_name LIKE 'gh-aw-cao-dashboard-data:%')
		AND store_name='workflows' ORDER BY record_key LIMIT 200001`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	overrides := object{}
	for rows.Next() {
		if len(overrides) >= 200_000 {
			return nil, errors.New("canonical workflow compiler refresh exceeds max input rows")
		}
		var key, content string
		if err := rows.Scan(&key, &content); err != nil {
			return nil, err
		}
		var workflow object
		if len(content) > 32<<20 || json.Unmarshal([]byte(content), &workflow) != nil || workflow == nil {
			return nil, errors.New("canonical workflow compiler refresh encountered a malformed record")
		}
		id := text(workflow["id"])
		if id == "" {
			_ = json.Unmarshal([]byte(key), &id)
		}
		if id == "" {
			return nil, errors.New("canonical workflow compiler refresh requires a workflow identity")
		}
		if _, duplicate := overrides[id]; duplicate {
			return nil, errors.New("canonical workflow compiler refresh encountered a duplicate workflow identity")
		}
		fields := object{"ghAwCurrentVersion": version.normalized}
		if installed := text(workflow["ghAwVersion"]); installed != "" {
			fields["ghAwUpdateState"] = compilerUpdateState(installed, version.normalized)
		}
		overrides[id] = fields
	}
	return overrides, rows.Err()
}

func (w *Workspace) refreshCompilerMetadata(ctx context.Context) error {
	if w.options.DataDirectory != "" {
		return nil
	}
	content, err := gh(ctx, w.options, "api", "repos/github/gh-aw/releases/latest")
	if err != nil {
		return errors.New("unable to refresh the latest stable gh-aw release; check GitHub CLI authentication")
	}
	var release struct {
		TagName    string `json:"tag_name"`
		Draft      bool
		Prerelease bool
	}
	if json.Unmarshal(content, &release) != nil || release.Draft || release.Prerelease {
		return errors.New("GitHub returned an invalid latest stable gh-aw release")
	}
	sources, _, err := readObject(filepath.Join(w.SourceDirectory, "inventory-sources.json"))
	if err != nil {
		return err
	}
	sources, err = RefreshCompilerRelease(sources, release.TagName)
	if err != nil {
		return err
	}
	overrides, err := canonicalCompilerOverrides(ctx, w.DatabasePath, release.TagName)
	if err != nil {
		return err
	}
	content, err = json.Marshal(overrides)
	if err != nil {
		return err
	}
	if len(content) > 32<<20 {
		return errors.New("canonical workflow compiler overrides exceed the file-size limit")
	}
	if err := atomicWrite(w.SourceDirectory, "compiler-overrides.json", content); err != nil {
		return err
	}
	if w.options.Canvas {
		sources, err = refreshCompilerVersions(ctx, sources, func(ctx context.Context, path string) (compilerResponse, error) {
			content, err := gh(ctx, w.options, "api", path, "--include")
			if err != nil {
				return compilerResponse{}, err
			}
			return readCompilerResponse(content, path)
		})
		if err != nil {
			return err
		}
	}
	content, err = json.Marshal(sources)
	if err != nil {
		return err
	}
	return atomicWrite(w.SourceDirectory, "inventory-sources.json", content)
}
