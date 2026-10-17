package cli

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

const catalogRepository = "githubnext/gh-aw-cao"

var commitPattern = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func installedCampaignRevision(campaign string) (string, error) {
	// Packages supersede legacy campaign records, matching the Node CLI.
	var revision string
	found := false
	for _, directory := range []string{"campaigns", "packages"} {
		directory, err := repositoryPath(filepath.Join(".github", "aw", directory))
		if err != nil {
			return "", err
		}
		entries, err := os.ReadDir(directory)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			recordPath, err := repositoryPath(filepath.Join(directory, entry.Name()))
			if err != nil {
				return "", err
			}
			content, err := os.ReadFile(recordPath)
			if err != nil {
				return "", err
			}
			var record map[string]json.RawMessage
			if err := json.Unmarshal(content, &record); err != nil {
				return "", fmt.Errorf("%s contains invalid JSON: %w", recordPath, err)
			}
			text := func(key string) string {
				var value string
				if err := json.Unmarshal(record[key], &value); err != nil {
					return ""
				}
				return strings.TrimSpace(value)
			}
			name := text("package")
			if name == "" {
				name = text("campaign")
			}
			if name == "" {
				name, _, _ = strings.Cut(text("source"), "@")
				name = strings.TrimSpace(name)
			}
			if name == catalogRepository+"/"+campaign {
				revision, found = text("resolvedCommit"), true
			}
		}
	}
	if !found {
		return "", fmt.Errorf("no installed CAO package record found for %s/%s", catalogRepository, campaign)
	}
	if !commitPattern.MatchString(revision) {
		return "", fmt.Errorf("CAO package record must contain a full resolvedCommit SHA: %q", revision)
	}
	return strings.ToLower(revision), nil
}

// Resolve existing ancestors as well as the leaf, so missing paths cannot hide
// a symlink outside the control repository.
func repositoryPath(destination string) (string, error) {
	root, err := os.Getwd()
	if err != nil {
		return "", err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	ancestor := resolved
	var missing []string
	for {
		canonical, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			for index := len(missing) - 1; index >= 0; index-- {
				canonical = filepath.Join(canonical, missing[index])
			}
			relative, err := filepath.Rel(root, canonical)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
				return "", fmt.Errorf("installed package destination escapes the repository: %s", destination)
			}
			return resolved, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", err
		}
		missing = append(missing, filepath.Base(ancestor))
		ancestor = parent
	}
}

func materializeCampaign(ctx context.Context, gh ghExecutor, campaign, sourceRoot string) (*campaignDeclaration, error) {
	destination, err := repositoryPath(campaign)
	if err != nil {
		return nil, err
	}
	intelligence, err := repositoryPath(filepath.Join(".github", "cao", "intelligence", campaign+".json"))
	if err != nil {
		return nil, err
	}
	staging, err := os.MkdirTemp(".", ".cao-campaign-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	if sourceRoot != "" {
		err = stageTrackedCampaign(ctx, sourceRoot, staging, campaign)
	} else {
		var revision string
		revision, err = installedCampaignRevision(campaign)
		if err == nil {
			var archive, stderr string
			archive, stderr, err = gh(ctx, "api", "--hostname", "github.com", "/repos/"+catalogRepository+"/tarball/"+revision)
			if err != nil {
				err = commandError("unable to download CAO "+revision, stderr, err)
			} else {
				err = stageCampaignArchive(ctx, strings.NewReader(archive), staging, campaign)
			}
		}
	}
	if err != nil {
		return nil, err
	}
	resource := filepath.Join(staging, campaign)
	declaration, err := readCampaignDeclaration(resource, campaign)
	if err != nil {
		return nil, err
	}
	metadata, err := os.ReadFile(filepath.Join(resource, "intelligence.json"))
	hasMetadata := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Only the selected campaign is replaced; removed files must not survive.
	if err := os.RemoveAll(destination); err != nil {
		return nil, err
	}
	if err := os.Rename(resource, destination); err != nil {
		return nil, err
	}
	if err := os.Remove(intelligence); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if hasMetadata {
		if err := os.MkdirAll(filepath.Dir(intelligence), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(intelligence, metadata, 0o644); err != nil {
			return nil, err
		}
	}
	return declaration, nil
}

func stageTrackedCampaign(ctx context.Context, sourceRoot, staging, campaign string) error {
	command := exec.CommandContext(ctx, "git", "-C", sourceRoot, "ls-files", "-z", "--", campaign)
	listing, err := command.Output()
	if err != nil {
		return fmt.Errorf("unable to list tracked CAO source files for %s: %w", campaign, err)
	}
	files := strings.Split(strings.TrimSuffix(string(listing), "\x00"), "\x00")
	if len(files) == 1 && files[0] == "" {
		return fmt.Errorf("CAO source resource has no tracked files: %s", campaign)
	}
	for _, file := range files {
		if !safeCampaignPath(file, campaign) {
			return fmt.Errorf("unsafe tracked CAO source path: %s", file)
		}
		source := filepath.Join(sourceRoot, filepath.FromSlash(file))
		canonical, err := filepath.EvalSymlinks(source)
		if err != nil {
			return err
		}
		if canonical != source {
			return fmt.Errorf("CAO source resource must not contain symlinks: %s", file)
		}
		info, err := os.Stat(source)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("CAO source resource is not a regular file: %s", file)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		input, err := os.Open(source)
		if err != nil {
			return err
		}
		err = stageCampaignFile(staging, file, info.Mode(), input)
		closeErr := input.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func safeCampaignPath(file, campaign string) bool {
	return strings.HasPrefix(file, campaign+"/") && path.Clean(file) == file &&
		!strings.ContainsAny(file, "\\:\x00") && filepath.IsLocal(filepath.FromSlash(file))
}

func stageCampaignFile(staging, name string, mode os.FileMode, input io.Reader) error {
	destination := filepath.Join(staging, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644|mode&0o111)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	closeErr := output.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func stageCampaignArchive(ctx context.Context, archive io.Reader, staging, campaign string) error {
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		return fmt.Errorf("invalid CAO archive: %w", err)
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	var root string
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			_, err := io.Copy(io.Discard, compressed)
			return err
		}
		if err != nil {
			return fmt.Errorf("invalid CAO archive: %w", err)
		}
		if header.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name := strings.TrimRight(header.Name, "/")
		if name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") ||
			name == ".." || strings.HasPrefix(name, "../") || strings.ContainsAny(name, "\\:\x00") {
			return fmt.Errorf("unsafe CAO archive path: %q", header.Name)
		}
		entryRoot, resource, _ := strings.Cut(name, "/")
		if root == "" {
			root = entryRoot
		} else if root != entryRoot {
			return fmt.Errorf("CAO archive must contain exactly one repository root")
		}
		if resource != campaign && !strings.HasPrefix(resource, campaign+"/") {
			continue
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if !safeCampaignPath(resource, campaign) {
			return fmt.Errorf("unsafe CAO campaign path: %q", resource)
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return fmt.Errorf("unsupported CAO archive entry type for %s", resource)
		}
		if err := stageCampaignFile(staging, resource, os.FileMode(header.Mode), reader); err != nil {
			return err
		}
	}
}
