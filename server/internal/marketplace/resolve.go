package marketplace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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
	Path           string
	Ref            string
	ResolvedCommit string
}

var awManifestSuffix = regexp.MustCompile(`/?aw\.yml$`)

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
	return Package{
		ID:                 coordinates.RegistryID + ":" + sourceCoordinate,
		RegistryID:         coordinates.RegistryID,
		RegistryName:       coordinates.RegistryName,
		RegistryPrecedence: coordinates.Precedence,
		Name:               name,
		Description:        scalar(source, "description"),
		Publisher:          publisher,
		Repository:         coordinates.Repository,
		Path:               packagePath,
		Ref:                coordinates.Ref,
		ResolvedCommit:     coordinates.ResolvedCommit,
		Version:            version,
		Icon:               icon,
		Artwork:            scalar(source, "artwork"),
		Contents:           contents,
		Source:             sourceCoordinate,
		AddCommand:         "./cao.sh add " + sourceCoordinate,
	}, nil
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
	entries := manifestEntries(rawTree, prefix)

	packages := make([]Package, 0, len(entries))
	for _, entry := range entries {
		blobPayload, err := githubJSON(ctx, opts, http.MethodGet,
			fmt.Sprintf("%s/repos/%s/git/blobs/%s", base, repositoryPath, entry.sha), token)
		if err != nil {
			return nil, err
		}
		encoding, _ := blobPayload["encoding"].(string)
		content, _ := blobPayload["content"].(string)
		if encoding != "base64" || content == "" {
			return nil, fmt.Errorf("package manifest blob is invalid")
		}
		decoded, err := base64.StdEncoding.DecodeString(stripBase64Whitespace(content))
		if err != nil {
			return nil, fmt.Errorf("package manifest blob is invalid")
		}
		manifest := string(decoded)
		if scalar(manifest, "private") == "true" {
			continue
		}
		pkg, err := ParsePackageManifest(manifest, Coordinates{
			RegistryID:     registry.ID,
			RegistryName:   registry.Name,
			Precedence:     precedence,
			Repository:     registry.Repository,
			Path:           entry.path,
			Ref:            registry.Ref,
			ResolvedCommit: commit,
		})
		if err != nil {
			return nil, err
		}
		packages = append(packages, pkg)
	}
	return packages, nil
}

func manifestEntries(rawTree []any, prefix string) []treeEntry {
	var entries []treeEntry
	for _, raw := range rawTree {
		if len(entries) >= maxPackagesPerRegistry {
			break
		}
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
		if !strings.HasPrefix(entryPath, prefix) || !strings.HasSuffix(entryPath, "/aw.yml") {
			continue
		}
		if entryPath == prefix+"aw.yml" {
			continue
		}
		relative := entryPath[len(prefix):]
		firstSegment, _, _ := strings.Cut(relative, "/")
		if internalPackages[firstSegment] {
			continue
		}
		entries = append(entries, treeEntry{path: entryPath, sha: entrySHA})
	}
	return entries
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
