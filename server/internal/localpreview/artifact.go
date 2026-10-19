package localpreview

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const artifactName = "central-agentic-ops-dashboard"

var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var digestPattern = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)

func gh(ctx context.Context, options Options, arguments ...string) ([]byte, error) {
	executable := options.GHExecutable
	if executable == "" {
		executable = "gh"
	}
	command := exec.CommandContext(ctx, executable, arguments...) // #nosec G204 -- Operator-configured GitHub CLI with fixed read-only argv, never a shell.
	command.Dir = options.Workspace
	command.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1")
	content, err := command.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Neither stdout nor stderr from authentication failures belongs in
		// operator diagnostics: credential helpers can echo token material.
		return nil, errors.New("GitHub CLI request failed; authenticate with Actions read access")
	}
	return content, nil
}

func download(ctx context.Context, options Options, destination string) (string, error) {
	if options.Repository != "" && !repositoryPattern.MatchString(options.Repository) {
		return "", errors.New("repository must be OWNER/REPOSITORY")
	}
	if _, err := gh(ctx, options, "auth", "status", "--hostname", "github.com"); err != nil {
		return "", err
	}
	repository := options.Repository
	if repository == "" {
		repository = "{owner}/{repo}"
	}
	content, err := gh(ctx, options, "api", "repos/"+repository)
	if err != nil {
		return "", err
	}
	var metadata struct {
		DefaultBranch string `json:"default_branch"`
		FullName      string `json:"full_name"`
	}
	if json.Unmarshal(content, &metadata) != nil || metadata.DefaultBranch == "" || !repositoryPattern.MatchString(metadata.FullName) {
		return "", errors.New("unable to determine the control repository default branch")
	}
	if options.Repository != "" && !strings.EqualFold(options.Repository, metadata.FullName) {
		return "", errors.New("GitHub CLI returned a different control repository")
	}
	repository = metadata.FullName
	content, err = gh(ctx, options, "api", "repos/"+repository+"/actions/artifacts?name="+artifactName+"&per_page=100")
	if err != nil {
		return "", err
	}
	type artifact struct {
		Name        string    `json:"name"`
		Expired     *bool     `json:"expired"`
		CreatedAt   time.Time `json:"created_at"`
		ExpiresAt   time.Time `json:"expires_at"`
		WorkflowRun struct {
			ID int64 `json:"id"`
		} `json:"workflow_run"`
	}
	var response struct {
		Artifacts []artifact `json:"artifacts"`
	}
	if err := json.Unmarshal(content, &response); err != nil {
		return "", errors.New("dashboard artifact response is malformed")
	}
	current := []artifact{}
	for _, candidate := range response.Artifacts {
		if candidate.Name == artifactName && candidate.Expired != nil && !*candidate.Expired &&
			!candidate.CreatedAt.IsZero() && (candidate.ExpiresAt.IsZero() || candidate.ExpiresAt.After(time.Now())) {
			current = append(current, candidate)
		}
	}
	sort.SliceStable(current, func(i, j int) bool { return current[i].CreatedAt.After(current[j].CreatedAt) })
	if len(current) == 0 || current[0].WorkflowRun.ID <= 0 {
		return "", errors.New("no current central-agentic-ops-dashboard artifact is available; run the dashboard action first")
	}
	runID := fmt.Sprint(current[0].WorkflowRun.ID)
	content, err = gh(ctx, options, "api", "repos/"+repository+"/actions/runs/"+runID)
	if err != nil {
		return "", err
	}
	var provenance struct {
		Status         string `json:"status"`
		Conclusion     string `json:"conclusion"`
		HeadBranch     string `json:"head_branch"`
		Path           string `json:"path"`
		HeadRepository struct {
			FullName string `json:"full_name"`
		} `json:"head_repository"`
	}
	if json.Unmarshal(content, &provenance) != nil || provenance.Conclusion != "success" ||
		provenance.HeadBranch != metadata.DefaultBranch || provenance.Path != ".github/workflows/cao-dashboard.yml" ||
		(provenance.Status != "" && provenance.Status != "completed") ||
		(provenance.HeadRepository.FullName != "" && !strings.EqualFold(provenance.HeadRepository.FullName, repository)) {
		return "", errors.New("latest dashboard artifact is not from a successful trusted dashboard workflow on the default branch")
	}
	if _, err := gh(ctx, options, "run", "download", runID, "--name", artifactName, "--dir", destination, "--repo", repository); err != nil {
		return "", err
	}
	return repository, nil
}

type artifactIndex struct {
	canonical string
	site      string
}

func inspectArtifact(ctx context.Context, directory string) (artifactIndex, error) {
	var result artifactIndex
	var sites []string
	err := filepath.WalkDir(directory, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("dashboard artifact must not contain symbolic links")
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("dashboard artifact must contain only regular files")
		}
		switch entry.Name() {
		case "inventory-sources.json":
			// A partial canonical directory is an error too, not an excuse
			// to silently choose a different snapshot from the artifact.
			if result.canonical != "" {
				return errors.New("dashboard artifact contains multiple canonical data directories")
			}
			result.canonical = filepath.Dir(name)
		case "index.html":
			sites = append(sites, filepath.Dir(name))
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	if result.canonical == "" {
		return result, errors.New("dashboard artifact contains no canonical data directory")
	}
	for _, candidate := range []string{result.canonical, filepath.Dir(result.canonical), directory} {
		for _, site := range sites {
			if candidate == site {
				result.site = site
				return result, nil
			}
		}
	}
	if len(sites) == 1 {
		result.site = sites[0]
	} else if len(sites) > 1 {
		return result, errors.New("dashboard artifact contains multiple ambiguous published sites")
	}
	return result, nil
}

func validateSnapshot(ctx context.Context, directory string) error {
	manifestPath, err := regularFile(directory, "payload-hashes.json")
	if err != nil {
		return errors.New("canonical snapshot is missing payload-hashes.json")
	}
	hashes, _, err := readObject(manifestPath)
	if err != nil {
		return err
	}
	expected, _ := hashes["gh-aw-logs.sqlite"].(string)
	if !digestPattern.MatchString(expected) {
		return errors.New("canonical snapshot manifest contains no valid SQLite SHA-256")
	}
	names := make([]string, 0, len(hashes))
	for name := range hashes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !fs.ValidPath(name) || strings.ContainsAny(name, "\\:\x00\r\n?#%") || path.Clean(name) != name {
			return errors.New("canonical snapshot manifest contains an unsafe payload path")
		}
		expected, ok := hashes[name].(string)
		if !ok || !digestPattern.MatchString(expected) {
			return errors.New("canonical snapshot manifest contains an invalid payload digest")
		}
		file, err := regularFile(directory, name)
		if err != nil {
			return fmt.Errorf("canonical snapshot payload is missing or unsafe: %s", name)
		}
		actual, err := hashFile(file)
		if err != nil {
			return err
		}
		if !strings.EqualFold(expected, actual) {
			return fmt.Errorf("canonical snapshot checksum mismatch: %s", name)
		}
		if strings.HasSuffix(name, ".jsonl") {
			if err := validateJSONL(file); err != nil {
				return fmt.Errorf("canonical snapshot contains malformed JSONL: %s", name)
			}
		}
	}
	inventoryPath, err := regularFile(directory, "inventory-sources.json")
	if err != nil {
		return err
	}
	if _, _, err := readObject(inventoryPath); err != nil {
		return err
	}
	return validateSQLite(ctx, filepath.Join(directory, "gh-aw-logs.sqlite"))
}

func hashFile(name string) (string, error) {
	file, err := os.Open(name) // #nosec G304 -- Artifact paths passed regularFile containment and symlink checks.
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validateJSONL(name string) error {
	file, err := os.Open(name) // #nosec G304 -- Artifact paths passed regularFile containment and symlink checks.
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) != 0 {
			var object map[string]any
			if json.Unmarshal(line, &object) != nil || object == nil {
				return errors.New("JSONL records must be JSON objects")
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func validateSQLite(ctx context.Context, name string) error {
	dsn := url.URL{Scheme: "file", Path: name, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	var status string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&status); err != nil || status != "ok" {
		return errors.New("canonical SQLite snapshot is malformed")
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(DISTINCT database_name) FROM __idb_records
		WHERE database_name='gh-aw-cao-dashboard-data' OR database_name LIKE 'gh-aw-cao-dashboard-data:%'`).Scan(&count); err != nil {
		return errors.New("SQLite snapshot is missing canonical IndexedDB records")
	}
	if count == 0 {
		// An empty canonical database can be registered before any runs exist.
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM __idb_databases
			WHERE (name='gh-aw-cao-dashboard-data' OR name LIKE 'gh-aw-cao-dashboard-data:%') AND version>0`).Scan(&count); err != nil {
			return errors.New("SQLite snapshot contains no registered canonical database")
		}
	}
	if count != 1 {
		return errors.New("SQLite snapshot must contain exactly one canonical dashboard database")
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM (
		SELECT 1 FROM __idb_records WHERE
		(database_name='gh-aw-cao-dashboard-data' OR database_name LIKE 'gh-aw-cao-dashboard-data:%')
		AND (NOT json_valid(record_key) OR NOT json_valid(value) OR json_type(value)<>'object') LIMIT 1
	)`).Scan(&count); err != nil || count != 0 {
		return errors.New("SQLite snapshot contains malformed canonical records")
	}
	return nil
}

func (w *Workspace) publishData(ctx context.Context) error {
	manifest, _, err := readObject(filepath.Join(w.SourceDirectory, "payload-hashes.json"))
	if err != nil {
		return err
	}
	published := make(map[string]any, len(manifest))
	for name, digest := range manifest {
		published[name] = digest
		if name == "gh-aw-logs.sqlite" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if strings.HasSuffix(name, ".jsonl") {
			content, err := redactJSONL(filepath.Join(w.SourceDirectory, filepath.FromSlash(name)))
			if err != nil {
				return err
			}
			hash := sha256.Sum256(content)
			published[name] = hex.EncodeToString(hash[:])
			if err := atomicWrite(w.OverlayDirectory, name, content); err != nil {
				return err
			}
		}
	}
	inventory, _, err := readObject(filepath.Join(w.SourceDirectory, "inventory-sources.json"))
	if err != nil {
		return err
	}
	content, err := json.Marshal(redact(inventory, ""))
	if err != nil {
		return err
	}
	// The server consumes this sidecar directly, so redact it in the private
	// copy as well as the public overlay. The canonical SQLite is untouched.
	if err := atomicWrite(w.SourceDirectory, "inventory-sources.json", content); err != nil {
		return err
	}
	if _, exists := published["inventory-sources.json"]; exists {
		hash := sha256.Sum256(content)
		published["inventory-sources.json"] = hex.EncodeToString(hash[:])
		manifest["inventory-sources.json"] = published["inventory-sources.json"]
	}
	if err := atomicWrite(w.OverlayDirectory, "inventory-sources.json", content); err != nil {
		return err
	}
	content, err = json.Marshal(published)
	if err != nil {
		return err
	}
	if err := atomicWrite(w.OverlayDirectory, "payload-hashes.json", content); err != nil {
		return err
	}
	content, err = json.Marshal(manifest)
	if err != nil {
		return err
	}
	return atomicWrite(w.SourceDirectory, "payload-hashes.json", content)
}

func redactJSONL(name string) ([]byte, error) {
	file, err := os.Open(name) // #nosec G304 -- Artifact paths passed regularFile containment and symlink checks.
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	var output strings.Builder
	reader := bufio.NewReader(file)
	for {
		line, readErr := reader.ReadBytes('\n')
		if strings.TrimSpace(string(line)) != "" {
			var object map[string]any
			if err := json.Unmarshal(line, &object); err != nil {
				return nil, err
			}
			content, err := json.Marshal(redact(object, ""))
			if err != nil {
				return nil, err
			}
			output.Write(content)
			output.WriteByte('\n')
		}
		if errors.Is(readErr, io.EOF) {
			return []byte(output.String()), nil
		}
		if readErr != nil {
			return nil, readErr
		}
	}
}
