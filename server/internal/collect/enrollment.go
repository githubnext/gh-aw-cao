// Package collect implements the optional server-side, webhook-driven
// acquisition profile described in specs/server-ingestion.md.
//
// The profile is off unless an operator configures it, and it is an
// alternative to — never a layer on top of — the GitHub Actions profile. It
// reuses the Actions profile's collection CLI, shard format, and canonical
// projection rather than reimplementing any of them.
package collect

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	installationsKey        = "collect:installations"
	repositoriesKey         = "collect:repositories"
	repositoryInstallations = "collect:repository-installation"
)

// Enrollment is the durable set of installations and repositories the App
// covers. In this profile enrollment is ingestion scope; it is never authority
// to act on a repository, and it is never derived from cao.json.
type Enrollment struct {
	Store *redisx.Store
}

// Coverage summarizes enrollment for status reporting.
type Coverage struct {
	Installations int64 `json:"installations"`
	Repositories  int64 `json:"repositories"`
}

// NormalizeRepository canonicalizes an "owner/name" reference, rejecting
// anything that is not a well-formed repository.
func NormalizeRepository(value string) (string, error) {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	owner, name, found := strings.Cut(trimmed, "/")
	if !found || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", fmt.Errorf("invalid repository reference %q", value)
	}
	if !validRepositorySegment(owner) || !validRepositorySegment(name) {
		return "", fmt.Errorf("invalid repository reference %q", value)
	}
	return owner + "/" + name, nil
}

func validRepositorySegment(value string) bool {
	// A segment that is "." or ".." would traverse out of the evidence lake
	// once it is joined into a shard path, and a leading "-" would be read as
	// a flag by the collection subprocess.
	if value == "" || value == "." || value == ".." {
		return false
	}
	if strings.HasPrefix(value, "-") || strings.HasPrefix(value, ".") {
		return false
	}
	for _, character := range value {
		switch {
		case character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '-', character == '_', character == '.':
		default:
			return false
		}
	}
	return true
}

// AddRepositories records repositories covered by one installation.
func (e Enrollment) AddRepositories(ctx context.Context, installationID int64, repositories []string) error {
	if installationID <= 0 {
		return errors.New("installation id is required")
	}
	if len(repositories) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(repositories))
	for _, repository := range repositories {
		name, err := NormalizeRepository(repository)
		if err != nil {
			return err
		}
		normalized = append(normalized, name)
	}
	if _, err := e.Store.SetAdd(ctx, installationsKey, strconv.FormatInt(installationID, 10)); err != nil {
		return err
	}
	if _, err := e.Store.SetAdd(ctx, repositoriesKey, normalized...); err != nil {
		return err
	}
	if _, err := e.Store.SetAdd(ctx, installationRepositoriesKey(installationID), normalized...); err != nil {
		return err
	}
	for _, repository := range normalized {
		// A repository that moved between installations must not stay in the
		// previous installation's set: a later removal or deletion event for
		// that installation would otherwise erase evidence the current
		// installation still covers.
		previous, err := e.Store.HashGet(ctx, repositoryInstallations, repository)
		if err != nil {
			return err
		}
		if previous != "" && previous != strconv.FormatInt(installationID, 10) {
			if identifier, parseErr := strconv.ParseInt(previous, 10, 64); parseErr == nil && identifier > 0 {
				if err := e.Store.SetRemove(ctx, installationRepositoriesKey(identifier), repository); err != nil {
					return err
				}
			}
		}
		if err := e.Store.HashSet(ctx, repositoryInstallations, repository,
			strconv.FormatInt(installationID, 10)); err != nil {
			return err
		}
	}
	return nil
}

// RemoveRepositories drops repositories from enrollment and reports the
// normalized names it removed, so the caller can erase their retained
// evidence.
//
// Removal is scoped to the installation that currently covers a repository. A
// stale event from an installation that no longer covers it clears only that
// installation's own membership, so a repository transferred to another
// installation keeps its enrollment and its evidence.
func (e Enrollment) RemoveRepositories(
	ctx context.Context, installationID int64, repositories []string) ([]string, error) {
	removed := make([]string, 0, len(repositories))
	for _, repository := range repositories {
		name, err := NormalizeRepository(repository)
		if err != nil {
			return removed, err
		}
		if installationID > 0 {
			if err := e.Store.SetRemove(ctx, installationRepositoriesKey(installationID), name); err != nil {
				return removed, err
			}
		}
		owner, err := e.Store.HashGet(ctx, repositoryInstallations, name)
		if err != nil {
			return removed, err
		}
		if owner != "" && installationID > 0 && owner != strconv.FormatInt(installationID, 10) {
			continue
		}
		if err := e.Store.SetRemove(ctx, repositoriesKey, name); err != nil {
			return removed, err
		}
		if err := e.Store.HashDelete(ctx, repositoryInstallations, name); err != nil {
			return removed, err
		}
		removed = append(removed, name)
	}
	return removed, nil
}

// RemoveInstallation drops an installation and every repository it covered,
// reporting those repositories so their retained evidence can be erased.
func (e Enrollment) RemoveInstallation(ctx context.Context, installationID int64) ([]string, error) {
	var removed []string
	cursor := ""
	for {
		repositories, next, err := e.Store.SetScan(ctx, installationRepositoriesKey(installationID), cursor, 500)
		if err != nil {
			return removed, err
		}
		names, err := e.RemoveRepositories(ctx, installationID, repositories)
		removed = append(removed, names...)
		if err != nil {
			return removed, err
		}
		if next == "0" || next == "" {
			break
		}
		cursor = next
	}
	if err := e.Store.Clear(ctx, installationRepositoriesKey(installationID)); err != nil {
		return removed, err
	}
	return removed, e.Store.SetRemove(ctx, installationsKey, strconv.FormatInt(installationID, 10))
}

// Enrolled reports whether a repository is in scope. Admission fails closed:
// an unknown repository is rejected rather than inferred from the payload.
func (e Enrollment) Enrolled(ctx context.Context, repository string) (bool, error) {
	name, err := NormalizeRepository(repository)
	if err != nil {
		return false, err
	}
	return e.Store.SetContains(ctx, repositoriesKey, name)
}

// InstallationFor reports which installation covers a repository.
func (e Enrollment) InstallationFor(ctx context.Context, repository string) (int64, error) {
	name, err := NormalizeRepository(repository)
	if err != nil {
		return 0, err
	}
	value, err := e.Store.HashGet(ctx, repositoryInstallations, name)
	if err != nil || value == "" {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

// Coverage reports enrollment size, published as source metadata so partial
// coverage is visible rather than rendered as a complete zero.
func (e Enrollment) Coverage(ctx context.Context) (Coverage, error) {
	installations, err := e.Store.SetCount(ctx, installationsKey)
	if err != nil {
		return Coverage{}, err
	}
	repositories, err := e.Store.SetCount(ctx, repositoriesKey)
	if err != nil {
		return Coverage{}, err
	}
	return Coverage{Installations: installations, Repositories: repositories}, nil
}

// Installations enumerates known installation identifiers.
func (e Enrollment) Installations(ctx context.Context) ([]int64, error) {
	cursor := ""
	var identifiers []int64
	for {
		members, next, err := e.Store.SetScan(ctx, installationsKey, cursor, 500)
		if err != nil {
			return nil, err
		}
		for _, member := range members {
			identifier, err := strconv.ParseInt(member, 10, 64)
			if err != nil {
				continue
			}
			identifiers = append(identifiers, identifier)
		}
		if next == "0" || next == "" {
			return identifiers, nil
		}
		cursor = next
	}
}

// ScanRepositories walks enrolled repositories by cursor so cold start over a
// very large enrollment set is resumable and never blocks Redis.
func (e Enrollment) ScanRepositories(ctx context.Context, cursor string, count int) ([]string, string, error) {
	return e.Store.SetScan(ctx, repositoriesKey, cursor, count)
}

func installationRepositoriesKey(installationID int64) string {
	return "collect:installation:" + strconv.FormatInt(installationID, 10) + ":repositories"
}
