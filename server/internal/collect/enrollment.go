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
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var enrollmentLog = logger.New("cao:collect:enrollment")

const (
	installationsKey        = "collect:installations"
	repositoriesKey         = "collect:repositories"
	repositoryInstallations = "collect:repository-installation"
	enrollmentMutationLock  = "collect:enrollment-mutation"
	enrollmentLockTTL       = 30 * time.Second
)

var ErrEnrollmentMutationBusy = errors.New("enrollment mutation is already in progress")

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

func (e Enrollment) withMutationLock(
	ctx context.Context, mutate func(context.Context) error,
) error {
	token, err := operationToken()
	if err != nil {
		return err
	}
	acquired, err := e.Store.TryLock(ctx, enrollmentMutationLock, token, enrollmentLockTTL)
	if err != nil {
		return err
	}
	if !acquired {
		return ErrEnrollmentMutationBusy
	}

	operationCtx, cancelOperation := context.WithCancel(ctx)
	stopRenewal := make(chan struct{})
	renewalDone := make(chan struct{})
	lockLost := make(chan error, 1)
	go func() {
		defer close(renewalDone)
		ticker := time.NewTicker(enrollmentLockTTL / 3)
		defer ticker.Stop()
		for {
			select {
			case <-stopRenewal:
				return
			case <-operationCtx.Done():
				return
			case <-ticker.C:
				renewalCtx, cancel := context.WithTimeout(operationCtx, 5*time.Second)
				renewed, renewErr := e.renewMutationLock(renewalCtx, token)
				cancel()
				if renewErr != nil || !renewed {
					if renewErr == nil {
						renewErr = ErrEnrollmentMutationBusy
					}
					select {
					case lockLost <- renewErr:
					default:
					}
					cancelOperation()
					return
				}
			}
		}
	}()

	mutationErr := mutate(operationCtx)
	close(stopRenewal)
	<-renewalDone
	cancelOperation()
	if mutationErr == nil {
		select {
		case mutationErr = <-lockLost:
		default:
		}
	}
	unlockCtx, cancelUnlock := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancelUnlock()
	if err := e.Store.Unlock(unlockCtx, enrollmentMutationLock, token); mutationErr == nil {
		mutationErr = err
	}
	return mutationErr
}

func (e Enrollment) renewMutationLock(ctx context.Context, token string) (bool, error) {
	script := `if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end; return redis.call("PEXPIRE", KEYS[1], ARGV[2])`
	value, err := e.Store.Client.Do(ctx, "EVAL", script, "1",
		e.Store.Key("lock:"+enrollmentMutationLock), token,
		strconv.FormatInt(enrollmentLockTTL.Milliseconds(), 10))
	if err != nil {
		return false, err
	}
	return fmt.Sprint(value) == "1", nil
}

// AddRepositories records repositories covered by one installation.
func (e Enrollment) AddRepositories(ctx context.Context, installationID int64, repositories []string) error {
	if installationID <= 0 {
		return errors.New("installation id is required")
	}
	if len(repositories) == 0 {
		return nil
	}
	return e.withMutationLock(ctx, func(ctx context.Context) error {
		return e.addRepositories(ctx, installationID, repositories)
	})
}

func (e Enrollment) addRepositories(ctx context.Context, installationID int64, repositories []string) error {
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
	transferred := 0
	for _, repository := range normalized {
		// A repository that moved between installations must not stay in the
		// previous installation's set: a later removal or deletion event for
		// that installation would otherwise erase evidence the current
		// installation still covers.
		previous, err := e.Store.HashGet(ctx, repositoryInstallations, repository)
		if err != nil {
			return err
		}
		if previousInstallation, ok := repositoryTransfer(previous, installationID); ok {
			if err := e.Store.SetRemove(ctx, installationRepositoriesKey(previousInstallation), repository); err != nil {
				return err
			}
			transferred++
		}
		if err := e.Store.HashSet(ctx, repositoryInstallations, repository,
			strconv.FormatInt(installationID, 10)); err != nil {
			return err
		}
	}
	enrollmentLog.Printf("enrolled repositories installation=%d count=%d transferred=%d",
		installationID, len(normalized), transferred)
	return nil
}

// repositoryTransfer decides whether a repository's recorded owner in Redis
// differs from the installation now claiming it. It returns the previous
// installation id and whether the caller must move the repository out of
// that installation's set; an empty or unparsable previous owner, or one that
// already matches installationID, needs no transfer.
func repositoryTransfer(previous string, installationID int64) (previousInstallation int64, transferred bool) {
	if previous == "" || previous == strconv.FormatInt(installationID, 10) {
		return 0, false
	}
	identifier, err := strconv.ParseInt(previous, 10, 64)
	if err != nil || identifier <= 0 {
		return 0, false
	}
	return identifier, true
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
	return e.RemoveRepositoriesBefore(ctx, installationID, repositories, nil)
}

// RemoveRepositoriesBefore runs prepare with the normalized removal set while
// enrollment mutations are serialized, before changing membership.
func (e Enrollment) RemoveRepositoriesBefore(
	ctx context.Context,
	installationID int64,
	repositories []string,
	prepare func(context.Context, []string) error,
) ([]string, error) {
	removed := make([]string, 0, len(repositories))
	err := e.withMutationLock(ctx, func(ctx context.Context) error {
		normalized := make([]string, 0, len(repositories))
		for _, repository := range repositories {
			name, err := NormalizeRepository(repository)
			if err != nil {
				return err
			}
			normalized = append(normalized, name)
		}
		if prepare != nil {
			if err := prepare(ctx, normalized); err != nil {
				return err
			}
		}
		var err error
		removed, err = e.removeRepositories(ctx, installationID, normalized)
		return err
	})
	return removed, err
}

func (e Enrollment) removeRepositories(
	ctx context.Context, installationID int64, repositories []string,
) ([]string, error) {
	removed := make([]string, 0, len(repositories))
	stale := 0
	for _, repository := range repositories {
		name := repository
		if installationID > 0 {
			if err := e.Store.SetRemove(ctx, installationRepositoriesKey(installationID), name); err != nil {
				return removed, err
			}
		}
		owner, err := e.Store.HashGet(ctx, repositoryInstallations, name)
		if err != nil {
			return removed, err
		}
		if staleRemoval(owner, installationID) {
			stale++
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
	if stale > 0 {
		// A stale event from an installation that no longer covers a
		// repository must not erase evidence the current owner still needs;
		// the count is worth surfacing since it explains a removal request
		// that removed fewer repositories than requested.
		enrollmentLog.Printf("skipped stale removals installation=%d skipped=%d", installationID, stale)
	}
	return removed, nil
}

// staleRemoval reports whether a repository's recorded owner differs from the
// installation requesting removal. It returns true when removal must be
// skipped: an unowned repository, a request from an unknown installation, or
// a request that matches the recorded owner all proceed with removal.
func staleRemoval(owner string, installationID int64) bool {
	return owner != "" && installationID > 0 && owner != strconv.FormatInt(installationID, 10)
}

// RemoveInstallation drops an installation and every repository it covered,
// reporting those repositories so their retained evidence can be erased.
func (e Enrollment) RemoveInstallation(ctx context.Context, installationID int64) ([]string, error) {
	return e.RemoveInstallationBefore(ctx, installationID, nil)
}

// RemoveInstallationBefore prepares durable follow-up work from the exact
// membership snapshot that is removed, while enrollment mutations are locked.
func (e Enrollment) RemoveInstallationBefore(
	ctx context.Context, installationID int64, prepare func(context.Context, []string) error,
) ([]string, error) {
	var removed []string
	err := e.withMutationLock(ctx, func(ctx context.Context) error {
		repositories, err := e.RepositoriesForInstallation(ctx, installationID)
		if err != nil {
			return err
		}
		if prepare != nil {
			if err := prepare(ctx, repositories); err != nil {
				return err
			}
		}
		removed, err = e.removeRepositories(ctx, installationID, repositories)
		if err != nil {
			return err
		}
		if err := e.Store.Clear(ctx, installationRepositoriesKey(installationID)); err != nil {
			return err
		}
		enrollmentLog.Printf("removed installation=%d repositories=%d", installationID, len(removed))
		return e.Store.SetRemove(ctx, installationsKey, strconv.FormatInt(installationID, 10))
	})
	return removed, err
}

// RepositoriesForInstallation returns the current repository membership without
// changing it, so erasure work can be durably queued before membership removal.
func (e Enrollment) RepositoriesForInstallation(ctx context.Context, installationID int64) ([]string, error) {
	var names []string
	cursor := ""
	for {
		repositories, next, err := e.Store.SetScan(ctx, installationRepositoriesKey(installationID), cursor, 500)
		if err != nil {
			return nil, err
		}
		names = append(names, repositories...)
		if next == "0" || next == "" {
			break
		}
		cursor = next
	}
	sort.Strings(names)
	return names, nil
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
