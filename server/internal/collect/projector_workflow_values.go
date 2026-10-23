package collect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/ingest"
	"github.com/githubnext/gh-cao/server/internal/operationalvalue"
)

const localValueLockName = "value-local"
const localValueAttemptKey = "collect:value-local-attempt"

var ErrLocalValueBusy = errors.New("a local Value computation is already running")

func (p Projector) refreshWorkflowValueHealth(ctx context.Context) error {
	if p.CatalogRoot == "" || p.PolicyPath == "" || p.Enrollment.Metadata == nil {
		return nil
	}
	repositories, err := p.enrolledRepositories(ctx)
	if err != nil {
		return err
	}
	if len(repositories) == 0 {
		return nil
	}
	return operationalvalue.WriteCollectionHealth(ctx, operationalvalue.Config{
		Root: p.CatalogRoot, NodeBinary: p.node(), Repositories: repositories,
		Environment: collectionEnvironment(p.GitHubAPIURL), WorkerTimeout: 30 * time.Second,
	}, p.PolicyPath, p.Lake.Directory)
}

// CollectLocalValues never acquires a target credential or the projection lease.
// Its immutable snapshot and computation are disposable; only a short final
// publication shares the evidence lock with core collection and erasure.
func (p Projector) CollectLocalValues(ctx context.Context) error {
	if p.Leases == nil || p.State == nil || p.CatalogRoot == "" || p.PolicyPath == "" {
		return nil
	}
	token, err := operationToken()
	if err != nil {
		return err
	}
	acquired, err := p.Leases.TryLock(ctx, localValueLockName, token, 3*time.Minute)
	if err != nil {
		return err
	}
	if !acquired {
		return ErrLocalValueBusy
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = p.Leases.Unlock(release, localValueLockName, token)
	}()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	generation, err := p.State.OperationalState(ctx, projectionCompletedKey)
	if err != nil || len(generation) == 0 {
		return err
	}
	attempted, err := p.State.OperationalState(ctx, localValueAttemptKey)
	if err != nil || bytes.Equal(generation, attempted) {
		return err
	}
	// One bounded attempt per published input, not a per-workflow retry loop.
	if err := p.State.SetOperationalState(ctx, localValueAttemptKey, generation); err != nil {
		return err
	}
	workspace, err := os.MkdirTemp("", "cao-local-value-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(workspace) }()
	if err := copyLocalValueSnapshot(ctx, p.Lake, workspace); err != nil {
		return err
	}
	output := filepath.Join(workspace, "operational-values.jsonl")
	config := operationalvalue.Config{
		Root: p.CatalogRoot, NodeBinary: p.node(), Output: output,
		Database:    filepath.Join(workspace, "activity.sqlite"),
		Environment: collectionEnvironment(p.GitHubAPIURL), WorkerTimeout: 2 * time.Minute,
	}
	if err := operationalvalue.ComputeLocalSnapshot(ctx, config, p.PolicyPath, workspace, strconv.Itoa(p.windowDays())); err != nil {
		return err
	}
	content, err := readLocalValueFile(ctx, output, 16<<20)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || len(content) > 16<<20 {
		return errors.New("local Value output is unreadable or exceeds its byte budget")
	}
	publication, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	unlock, err := p.Lake.lockEvidence(publication)
	if err != nil {
		return err
	}
	defer unlock()
	repositories, err := p.enrolledRepositories(publication)
	if err != nil {
		return err
	}
	enrolled := map[string]bool{}
	for _, repository := range repositories {
		enrolled[strings.ToLower(repository)] = true
	}
	if err := operationalvalue.FilterRepositories(output, func(repository string) bool { return enrolled[repository] }); err != nil {
		return err
	}
	content, err = readLocalValueFile(publication, output, 16<<20)
	if err != nil {
		return err
	}
	previous, err := readLocalValueFile(publication, p.Lake.operationalValuesPath(), 16<<20)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if bytes.Equal(content, previous) {
		return nil
	}
	// The next ordinary projection publishes this result. Value must not create
	// a compute -> projection -> compute retry loop on incomplete local evidence.
	return WriteFileAtomic(p.Lake.operationalValuesPath(), content)
}

func copyLocalValueSnapshot(ctx context.Context, lake Lake, destination string) error {
	content, err := readLocalValueFile(ctx, lake.ManifestPath(), 1<<20)
	if err != nil {
		return err
	}
	var manifest ingest.Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return err
	}
	var names []string
	for name := range manifest {
		if (strings.HasPrefix(name, "gh-aw-logs-runs/") || strings.HasPrefix(name, "gh-aw-logs-records/")) &&
			strings.HasSuffix(name, ".jsonl") {
			if filepath.ToSlash(filepath.Clean(name)) != name || filepath.IsAbs(name) {
				return errors.New("local Value snapshot contains an unsafe path")
			}
			names = append(names, name)
		}
	}
	sort.Strings(names)
	names = append(names, "gh-aw-logs-shards/workflow-value-local.json")
	var total int64
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return err
		}
		source := filepath.Join(lake.Directory, filepath.FromSlash(name))
		info, err := os.Lstat(source)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 16<<20 {
			return errors.New("local Value snapshot contains an invalid or oversized file")
		}
		if total+info.Size() > 256<<20 {
			return errors.New("local Value snapshot exceeds its byte budget")
		}
		content, err := readLocalValueFile(ctx, source, min(16<<20, 256<<20-total))
		if err != nil {
			return err
		}
		total += int64(len(content))
		target := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(target, content, 0o600); err != nil {
			return err
		}
	}
	content, err = json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(destination, "payload-hashes.json"), content, 0o600); err != nil {
		return err
	}
	if _, _, _, err := ingest.ValidateManifest(destination); err != nil {
		return fmt.Errorf("local Value input changed during snapshotting: %w", err)
	}
	retained, err := readLocalValueFile(ctx, lake.operationalValuesPath(), 16<<20)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(destination, "operational-values.jsonl"), retained, 0o600)
}

func readLocalValueFile(ctx context.Context, path string, maxBytes int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, errors.New("local Value input is not a bounded regular file")
	}
	file, err := os.Open(path) // #nosec G304 -- confined snapshot or private output path, size checked before reading.
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > maxBytes {
		return nil, errors.New("local Value input grew beyond its byte budget")
	}
	return content, ctx.Err()
}
