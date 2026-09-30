package marketplace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// HTTPDoer is the minimal client interface Resolve needs, satisfied by
// *http.Client and by test doubles.
type HTTPDoer interface {
	Do(request *http.Request) (*http.Response, error)
}

// Options configures how registries are resolved. Every field has a safe
// default so a zero Options value talks to the real GitHub API and the real
// process environment.
type Options struct {
	// HTTPClient issues GitHub REST requests. Defaults to http.DefaultClient.
	HTTPClient HTTPDoer
	// Env resolves secret environment variable names. Defaults to os.LookupEnv.
	Env EnvLookup
	// Now supplies the current time for GitHub App JWT minting. Defaults to time.Now.
	Now func() time.Time
}

func (o Options) httpClient() HTTPDoer {
	if o.HTTPClient != nil {
		return o.HTTPClient
	}
	return http.DefaultClient
}

func (o Options) env() EnvLookup {
	if o.Env != nil {
		return o.Env
	}
	return os.LookupEnv
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func pathEscape(value string) string {
	return url.PathEscape(value)
}

func githubRequest(ctx context.Context, opts Options, method, requestURL, token string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, requestURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := opts.httpClient().Do(request)
	if err != nil {
		return nil, fmt.Errorf("GitHub API request failed: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = response.Body.Close()
		return nil, fmt.Errorf("GitHub API request failed with status %d", response.StatusCode)
	}
	return response, nil
}

func githubJSON(ctx context.Context, opts Options, method, requestURL, token string) (map[string]any, error) {
	response, err := githubRequest(ctx, opts, method, requestURL, token)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = response.Body.Close()
	}()
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode GitHub API response: %w", err)
	}
	return payload, nil
}

// Coordinates locates one package manifest blob within a resolved registry
// commit.
type Coordinates struct {
	RegistryID     string
	RegistryName   string
	Precedence     int
	Repository     string
	APIURL         string
	Path           string
	Ref            string
	ResolvedCommit string
	Readme         string
	ReadmePath     string
}

var awManifestSuffix = regexp.MustCompile(`/?aw\.yml$`)

var readmePattern = regexp.MustCompile(`(?i)^readme\.(?:md|markdown)$`)

// ParsePackageManifest normalizes one aw.yml manifest's safe, publicly
// documented fields into the shared Package DTO. It never reads any field
// activity/marketplace.mjs does not also read.
func ParsePackageManifest(source string, coordinates Coordinates) (Package, error) {
	if len(source) > maxManifestBytes {
		return Package{}, fmt.Errorf("package manifest exceeds size limit")
	}
	name := scalar(source, "name")
	if name == "" {
		return Package{}, fmt.Errorf("package manifest name is required")
	}
	contents := includes(source)
	readme := coordinates.Readme
	readmePath := coordinates.ReadmePath
	if readme == "" {
		readmePath = ""
	}
	version := scalar(source, "version")
	if version == "" {
		version = coordinates.Ref
	}
	packagePath := awManifestSuffix.ReplaceAllString(coordinates.Path, "")
	sourceCoordinate := coordinates.Repository
	if packagePath != "" {
		sourceCoordinate += "/" + packagePath
	}
	sourceCoordinate += "@" + coordinates.ResolvedCommit
	icon := scalar(source, "icon")
	if icon == "" {
		icon = "workflow"
	}
	publisher := coordinates.Repository
	if index := strings.Index(publisher, "/"); index >= 0 {
		publisher = publisher[:index]
	}
	packageID := strings.ToLower(coordinates.Repository)
	if packagePath != "" {
		packageID += "/" + strings.ToLower(packagePath)
	}
	return Package{
		ID:                 packageID,
		RegistryID:         coordinates.RegistryID,
		RegistryName:       coordinates.RegistryName,
		RegistryPrecedence: coordinates.Precedence,
		Name:               name,
		Description:        scalar(source, "description"),
		Publisher:          publisher,
		Repository:         coordinates.Repository,
		RepositoryLink:     repositoryLink(coordinates.Repository, coordinates.APIURL),
		Path:               packagePath,
		Ref:                coordinates.Ref,
		ResolvedCommit:     coordinates.ResolvedCommit,
		Version:            version,
		Icon:               icon,
		Artwork:            scalar(source, "artwork"),
		Contents:           contents,
		Readme:             readme,
		ReadmePath:         readmePath,
		Source:             sourceCoordinate,
		AddCommand:         "./cao.sh add " + sourceCoordinate,
		VerificationStatus: "unknown",
		VerificationSource: "unknown",
		MaintenanceStatus:  "unknown",
		MaintenanceSource:  "unknown",
		PopularitySource:   "unknown",
		SignalsObservedAt:  time.Now().UTC().Format(time.RFC3339),
		InstallationStatus: "unknown",
		AdoptionSource:     "unknown",
	}, nil
}

func repositoryLink(repository, apiURL string) *RepositoryLink {
	if !repositoryPattern.MatchString(repository) {
		return nil
	}
	if apiURL == "" {
		apiURL = "https://api.github.com"
	}
	api, err := url.Parse(apiURL)
	if err != nil || api.Scheme != "https" || api.Hostname() == "" || api.User != nil ||
		api.RawQuery != "" || api.Fragment != "" || api.EscapedPath() != api.Path {
		return nil
	}
	var webBase string
	switch {
	case strings.EqualFold(api.Hostname(), "api.github.com") && (api.Path == "" || api.Path == "/"):
		webBase = "https://github.com"
	case strings.HasSuffix(strings.TrimSuffix(api.Path, "/"), "/api/v3"):
		webBase = api.Scheme + "://" + api.Host + strings.TrimSuffix(strings.TrimSuffix(api.Path, "/"), "/api/v3")
	default:
		return nil
	}
	owner, name, _ := strings.Cut(repository, "/")
	return &RepositoryLink{
		Relation: "repository",
		Href:     strings.TrimRight(webBase, "/") + "/" + url.PathEscape(owner) + "/" + url.PathEscape(name),
		Label:    "Open " + repository + " on GitHub",
	}
}

const maxRepositorySignalBytes = 64 * 1024

func repositorySignals(ctx context.Context, opts Options, url, token string, commitPayload map[string]any, observed time.Time) (string, string, string, *int, *int, string) {
	unknown := func() (string, string, string, *int, *int, string) {
		return "unknown", "unknown", "", nil, nil, "unknown"
	}
	response, err := githubRequest(ctx, opts, http.MethodGet, url, token)
	if err != nil {
		return unknown()
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxRepositorySignalBytes+1))
	if err != nil || len(body) > maxRepositorySignalBytes {
		return unknown()
	}
	var repo map[string]any
	if err := json.Unmarshal(body, &repo); err != nil {
		return unknown()
	}
	if private, ok := repo["private"].(bool); !ok || private || repo["visibility"] != "public" {
		return unknown()
	}

	maintenanceStatus, maintenanceSource, lastMaintainedAt := "unknown", "unknown", ""
	if commitDetails, ok := commitPayload["commit"].(map[string]any); ok {
		if committer, ok := commitDetails["committer"].(map[string]any); ok {
			if date, ok := committer["date"].(string); ok {
				if maintained, err := time.Parse(time.RFC3339, date); err == nil && !maintained.After(observed) {
					lastMaintainedAt = maintained.UTC().Format(time.RFC3339)
					maintenanceStatus, maintenanceSource = "active", "github-repository"
					if observed.Sub(maintained) > 180*24*time.Hour {
						maintenanceStatus = "stale"
					}
				}
			}
		}
	}
	stars, starsOK := nonnegativeCount(repo["stargazers_count"])
	forks, forksOK := nonnegativeCount(repo["forks_count"])
	popularitySource := "unknown"
	if starsOK && forksOK {
		popularitySource = "github-public-repository"
	} else {
		stars, forks = nil, nil
	}
	return maintenanceStatus, maintenanceSource, lastMaintainedAt, stars, forks, popularitySource
}

func nonnegativeCount(raw any) (*int, bool) {
	number, ok := raw.(float64)
	if !ok || math.IsNaN(number) || number < 0 || number > float64(math.MaxInt) || math.Trunc(number) != number {
		return nil, false
	}
	count := int(number)
	return &count, true
}

func setPublisherVerification(pkg *Package, verified bool) {
	pkg.VerificationStatus, pkg.VerificationSource = "unknown", "unknown"
	if verified {
		pkg.VerificationStatus, pkg.VerificationSource = "verified", "control-policy"
	}
}

func scalarPattern(name string) *regexp.Regexp {
	return regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(name) + `:[ \t]*(.+?)[ \t]*$`)
}

// scalar reads a single top-level "name: value" line from a YAML manifest,
// mirroring the regex-based scalar() helper in activity/marketplace.mjs. A
// full YAML parser is deliberately not used so both backends read manifests
// identically.
func scalar(source, name string) string {
	match := scalarPattern(name).FindStringSubmatch(source)
	if match == nil {
		return ""
	}
	value := strings.TrimSpace(match[1])
	if len(value) >= 2 {
		if (strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) ||
			(strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'")) {
			return value[1 : len(value)-1]
		}
	}
	return value
}

var (
	includesBlockPattern = regexp.MustCompile(`(?m)^includes:[ \t]*\n((?:^[ \t]+.*\n?)*)`)
	includesLinePattern  = regexp.MustCompile(`^\s*-\s+(?:source:\s+)?([^#]+?)\s*$`)
	newlinePattern       = regexp.MustCompile(`\r?\n`)
)

// includes reads the manifest's "includes:" block, mirroring the includes()
// helper in activity/marketplace.mjs.
func includes(source string) []string {
	block := ""
	if match := includesBlockPattern.FindStringSubmatch(source); match != nil {
		block = match[1]
	}
	var result []string
	for _, line := range newlinePattern.Split(block, -1) {
		match := includesLinePattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		value := strings.Trim(match[1], `'"`)
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

type treeEntry struct {
	path string
	sha  string
}

// ResolveRegistry resolves one registry's ref to a commit, walks its Git tree
// for package manifests, and normalizes each into a Package. Callers are
// expected to isolate its error per registry (see Resolve).
func ResolveRegistry(ctx context.Context, registry Registry, precedence int, opts Options) ([]Package, error) {
	token, err := registryToken(ctx, registry, opts)
	if err != nil {
		return nil, err
	}
	base := apiBase(registry)
	owner, name, found := strings.Cut(registry.Repository, "/")
	if !found {
		return nil, fmt.Errorf("registry repository %q is invalid", registry.Repository)
	}
	repositoryPath := pathEscape(owner) + "/" + pathEscape(name)

	commitPayload, err := githubJSON(ctx, opts, http.MethodGet,
		fmt.Sprintf("%s/repos/%s/commits/%s", base, repositoryPath, pathEscape(registry.Ref)), token)
	if err != nil {
		return nil, err
	}
	commit, _ := commitPayload["sha"].(string)
	if !commitPattern.MatchString(commit) {
		return nil, fmt.Errorf("registry ref did not resolve to a commit")
	}

	treePayload, err := githubJSON(ctx, opts, http.MethodGet,
		fmt.Sprintf("%s/repos/%s/git/trees/%s?recursive=1", base, repositoryPath, commit), token)
	if err != nil {
		return nil, err
	}
	if truncated, _ := treePayload["truncated"].(bool); truncated {
		return nil, fmt.Errorf("registry tree is unavailable or truncated")
	}
	rawTree, ok := treePayload["tree"].([]any)
	if !ok {
		return nil, fmt.Errorf("registry tree is unavailable or truncated")
	}

	prefix := ""
	if registry.Path != "" {
		prefix = registry.Path + "/"
	}
	entries, truncated := manifestEntries(rawTree, prefix)
	if truncated {
		resolveLog.Printf("registry manifests truncated registry_id=%s limit=%d",
			registry.ID, maxPackagesPerRegistry)
	}
	readmes := readmeEntries(rawTree, prefix)

	observed := opts.now().UTC()
	maintenanceStatus, maintenanceSource, lastMaintainedAt, stars, forks, popularitySource :=
		repositorySignals(ctx, opts, fmt.Sprintf("%s/repos/%s", base, repositoryPath), token, commitPayload, observed)

	packages := make([]Package, 0, len(entries))
	skippedPrivate := 0
	for _, entry := range entries {
		blobPayload, err := githubJSON(ctx, opts, http.MethodGet,
			fmt.Sprintf("%s/repos/%s/git/blobs/%s", base, repositoryPath, entry.sha), token)
		if err != nil {
			return nil, err
		}
		manifest, err := decodeManifestBlob(blobPayload)
		if err != nil {
			return nil, err
		}
		if scalar(manifest, "private") == "true" {
			skippedPrivate++
			continue
		}
		readme, readmePath := "", ""
		if readmeEntry, ok := readmes[strings.TrimSuffix(entry.path, "aw.yml")]; ok {
			readme = fetchReadme(ctx, opts, base, repositoryPath, token, readmeEntry.sha)
			if readme != "" {
				readmePath = readmeEntry.path
			}
		}
		pkg, err := ParsePackageManifest(manifest, Coordinates{
			RegistryID:     registry.ID,
			RegistryName:   registry.Name,
			Precedence:     precedence,
			Repository:     registry.Repository,
			APIURL:         apiBase(registry),
			Path:           entry.path,
			Ref:            registry.Ref,
			ResolvedCommit: commit,
			Readme:         readme,
			ReadmePath:     readmePath,
		})
		if err != nil {
			return nil, err
		}
		pkg.SignalsObservedAt = observed.Format(time.RFC3339)
		pkg.MaintenanceStatus, pkg.MaintenanceSource, pkg.LastMaintainedAt = maintenanceStatus, maintenanceSource, lastMaintainedAt
		pkg.Stars, pkg.Forks, pkg.PopularitySource = stars, forks, popularitySource
		setPublisherVerification(&pkg, registry.VerifiedPublisher)
		packages = append(packages, pkg)
	}
	resolveLog.Printf("resolved registry registry_id=%s entries=%d packages=%d skipped_private=%d",
		registry.ID, len(entries), len(packages), skippedPrivate)
	return packages, nil
}

// decodeManifestBlob extracts and base64-decodes one aw.yml manifest from a
// GitHub git/blobs API response. It is a pure function so the blob-shape
// validation ResolveRegistry relies on (a missing encoding, empty content, or
// content that fails to base64-decode) is testable without a fake GitHub API.
func decodeManifestBlob(blobPayload map[string]any) (string, error) {
	encoding, _ := blobPayload["encoding"].(string)
	content, _ := blobPayload["content"].(string)
	if encoding != "base64" || content == "" {
		return "", fmt.Errorf("package manifest blob is invalid")
	}
	decoded, err := base64.StdEncoding.DecodeString(stripBase64Whitespace(content))
	if err != nil {
		return "", fmt.Errorf("package manifest blob is invalid")
	}
	return string(decoded), nil
}

// readmeEntries indexes each package directory's README blob by directory
// prefix. A README is optional presentation detail, so a directory without one
// simply resolves to no entry.
func readmeEntries(rawTree []any, prefix string) map[string]treeEntry {
	entries := map[string]treeEntry{}
	for _, raw := range rawTree {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		entryType, _ := entry["type"].(string)
		entryPath, _ := entry["path"].(string)
		entrySHA, _ := entry["sha"].(string)
		if entryType != "blob" || entryPath == "" || entrySHA == "" {
			continue
		}
		if !strings.HasPrefix(entryPath, prefix) {
			continue
		}
		separator := strings.LastIndex(entryPath, "/")
		if separator < 0 {
			continue
		}
		if !readmePattern.MatchString(entryPath[separator+1:]) {
			continue
		}
		if size, ok := entry["size"].(float64); ok && size > maxReadmeBytes {
			continue
		}
		directory := entryPath[:separator+1]
		if _, seen := entries[directory]; !seen {
			entries[directory] = treeEntry{path: entryPath, sha: entrySHA}
		}
	}
	return entries
}

// fetchReadme reads one README blob. Every failure resolves to empty content
// because an unreadable README must never fail an otherwise usable registry.
func fetchReadme(ctx context.Context, opts Options, base, repositoryPath, token, sha string) string {
	blobPayload, err := githubJSON(ctx, opts, http.MethodGet,
		fmt.Sprintf("%s/repos/%s/git/blobs/%s", base, repositoryPath, sha), token)
	if err != nil {
		return ""
	}
	encoding, _ := blobPayload["encoding"].(string)
	content, _ := blobPayload["content"].(string)
	if encoding != "base64" || content == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(stripBase64Whitespace(content))
	if err != nil || len(decoded) > maxReadmeBytes {
		return ""
	}
	return string(decoded)
}

// manifestEntries collects eligible package manifests from a registry tree in
// order, stopping at maxPackagesPerRegistry. truncated reports whether at least
// one further eligible manifest was dropped because of the cap.
func manifestEntries(rawTree []any, prefix string) (entries []treeEntry, truncated bool) {
	for _, raw := range rawTree {
		entry, ok := manifestTreeEntry(raw, prefix)
		if !ok {
			continue
		}
		if len(entries) >= maxPackagesPerRegistry {
			return entries, true
		}
		entries = append(entries, entry)
	}
	return entries, false
}

// manifestTreeEntry reports whether one raw Git tree entry is a package
// manifest within prefix, excluding the registry root manifest and internal
// packages.
func manifestTreeEntry(raw any, prefix string) (treeEntry, bool) {
	entry, ok := raw.(map[string]any)
	if !ok {
		return treeEntry{}, false
	}
	entryType, _ := entry["type"].(string)
	entryPath, _ := entry["path"].(string)
	entrySHA, _ := entry["sha"].(string)
	if entryType != "blob" || entryPath == "" || entrySHA == "" {
		return treeEntry{}, false
	}
	if !strings.HasPrefix(entryPath, prefix) || !strings.HasSuffix(entryPath, "/aw.yml") {
		return treeEntry{}, false
	}
	if entryPath == prefix+"aw.yml" {
		return treeEntry{}, false
	}
	relative := entryPath[len(prefix):]
	firstSegment, _, _ := strings.Cut(relative, "/")
	if internalPackages[firstSegment] {
		return treeEntry{}, false
	}
	return treeEntry{path: entryPath, sha: entrySHA}, true
}

func stripBase64Whitespace(value string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', '\r':
			return -1
		default:
			return r
		}
	}, value)
}
