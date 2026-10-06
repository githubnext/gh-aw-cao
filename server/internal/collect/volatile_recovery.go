package collect

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

// reconstructScope serializes fresh GitHub enumeration with webhook mutations.
// A partial enumeration never authorizes erasure or out-of-scope acknowledgments.
func (b Backfill) reconstructScope(ctx context.Context) (repositories []enrolledRepository, installations, failures int, err error) {
	err = b.Enrollment.withMutationLock(ctx, func(ctx context.Context) error {
		listed, listErr := b.Enumerator.ListInstallations(ctx)
		if listErr != nil {
			return listErr
		}
		installations = len(listed)
		type scope struct {
			installation githubapp.Installation
			names        []string
		}
		scopes := make([]scope, 0, len(listed))
		fresh := make(map[string]int64)
		for _, installation := range listed {
			covered, readErr := b.Enumerator.ListRepositories(ctx, installation.ID)
			if readErr != nil {
				failures++
				return fmt.Errorf("reconstruct installation scope: %w", readErr)
			}
			names, enrolled, skipped := normalizeEnumeratedRepositories(covered)
			if skipped != 0 {
				failures++
				return errors.New("fresh enrollment contains invalid repository identities")
			}
			for _, name := range names {
				if previous, exists := fresh[name]; exists && previous != installation.ID {
					return errors.New("fresh enrollment contains conflicting repository ownership")
				}
				fresh[name] = installation.ID
				if b.ScopeLimit > 0 && len(fresh) > b.ScopeLimit {
					return operational.ErrCapacity
				}
			}
			for i := range enrolled {
				enrolled[i].installationID = installation.ID
			}
			repositories = append(repositories, enrolled...)
			scopes = append(scopes, scope{installation, names})
		}
		retained, readErr := b.Lake.RetainedRepositories(ctx, b.ScopeLimit)
		if readErr != nil {
			return readErr
		}
		previous := make(map[string]struct{}, len(retained))
		for _, name := range retained {
			previous[name] = struct{}{}
		}
		cursor := "0"
		for {
			names, next, scanErr := b.Enrollment.ScanRepositories(ctx, cursor, 500)
			if scanErr != nil {
				return scanErr
			}
			for _, name := range names {
				previous[name] = struct{}{}
				if b.ScopeLimit > 0 && len(previous) > b.ScopeLimit {
					return operational.ErrCapacity
				}
			}
			if next == "0" || next == "" {
				break
			}
			cursor = next
		}
		prefixes := make(map[string]string, len(previous)+len(fresh))
		checkPrefix := func(name string) error {
			prefix := b.Lake.ShardPrefix(name)
			if owner, exists := prefixes[prefix]; exists && owner != name {
				return errors.New("ambiguous retained shard prefixes prevent safe scope recovery")
			}
			prefixes[prefix] = name
			return nil
		}
		for name := range fresh {
			if err := checkPrefix(name); err != nil {
				return err
			}
		}
		for name := range previous {
			if err := checkPrefix(name); err != nil {
				return err
			}
		}
		for _, s := range scopes {
			if err := b.Enrollment.addRepositories(ctx, s.installation.ID, s.names); err != nil {
				return err
			}
		}
		for name := range previous {
			if _, included := fresh[name]; included {
				continue
			}
			token, err := operationToken()
			if err != nil {
				return err
			}
			if err := b.Queue.LockRepository(ctx, name, token, b.Projector.lockTTL()); err != nil {
				return err
			}
			owner, err := b.Enrollment.InstallationFor(ctx, name)
			if err == nil {
				_, err = b.Enrollment.removeRepositories(ctx, owner, []string{name})
			}
			if err == nil {
				err = b.Lake.Forget(name)
			}
			unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
			unlockErr := b.Queue.UnlockRepository(unlockCtx, name, token)
			cancel()
			if err != nil || unlockErr != nil {
				return errors.Join(err, unlockErr)
			}
		}
		oldInstallations, err := b.Enrollment.Installations(ctx)
		if err != nil {
			return err
		}
		currentInstallations := make(map[int64]struct{}, len(listed))
		for _, installation := range listed {
			currentInstallations[installation.ID] = struct{}{}
		}
		for _, installation := range oldInstallations {
			if _, present := currentInstallations[installation]; present {
				continue
			}
			if err := b.Enrollment.Store.Clear(ctx, installationRepositoriesKey(installation)); err != nil {
				return err
			}
			if err := b.Enrollment.Store.RemoveMembers(ctx, installationsKey, fmt.Sprint(installation)); err != nil {
				return err
			}
		}
		return nil
	})
	return
}

// RetainedRepositories discovers identity from authoritative raw shard content,
// never from lossy filename prefixes or from browser state.
func (l Lake) RetainedRepositories(ctx context.Context, limit int) ([]string, error) {
	if err := l.Validate(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(l.ShardDirectory())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{})
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !entry.Type().IsRegular() || !strings.Contains(entry.Name(), "-logs-") || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		name, err := retainedShardRepository(ctx, filepath.Join(l.ShardDirectory(), entry.Name()))
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(entry.Name(), l.ShardPrefix(name)) {
			return nil, errors.New("retained shard filename does not match its authoritative identity")
		}
		seen[name] = struct{}{}
		if limit > 0 && len(seen) > limit {
			return nil, operational.ErrCapacity
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	return names, nil
}

func retainedShardRepository(ctx context.Context, path string) (string, error) {
	file, err := os.Open(path) // #nosec G304 -- path is a regular shard discovered in the configured evidence lake.
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	var identity string
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		var record struct {
			Request struct {
				Repository string `json:"repository"`
			} `json:"request"`
			Run struct {
				FullName     string          `json:"repository_full_name"`
				Repository   json.RawMessage `json:"repository"`
				Organization string          `json:"organization"`
			} `json:"run"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return "", errors.New("retained shard contains invalid JSON")
		}
		candidates := []string{record.Request.Repository, record.Run.FullName}
		var repository string
		if len(record.Run.Repository) != 0 && json.Unmarshal(record.Run.Repository, &repository) == nil {
			if strings.Contains(repository, "/") {
				candidates = append(candidates, repository)
			} else if record.Run.Organization != "" && repository != "" {
				candidates = append(candidates, record.Run.Organization+"/"+repository)
			}
		}
		for _, candidate := range candidates {
			if candidate == "" {
				continue
			}
			name, err := NormalizeRepository(candidate)
			if err != nil {
				return "", err
			}
			if identity != "" && identity != name {
				return "", errors.New("retained shard contains conflicting repository identities")
			}
			identity = name
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read retained shard identity: %w", err)
	}
	if identity == "" {
		return "", errors.New("retained shard has no authoritative repository identity")
	}
	return identity, nil
}
