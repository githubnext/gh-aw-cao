package simulator

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

type LakeResult struct {
	Repositories int `json:"repositories"`
	Runs         int `json:"runs"`
}

// WriteLake streams canonical synthetic evidence, not GitHub data or raw logs.
// It exercises the ordinary hash verification and native Postgres ingestion.
func (s Scenario) WriteLake(ctx context.Context, directory string, horizonDays int) (LakeResult, error) {
	s.defaults()
	if err := s.Validate(); err != nil {
		return LakeResult{}, err
	}
	if s.History == nil || horizonDays < 1 || horizonDays > s.History.Days || !filepath.IsAbs(directory) {
		return LakeResult{}, errors.New("synthetic lake requires history, a covered horizon, and an absolute directory")
	}
	shards := filepath.Join(directory, "gh-aw-logs-runs")
	if err := os.MkdirAll(shards, 0o750); err != nil {
		return LakeResult{}, err
	}
	path := filepath.Join(shards, "synthetic.jsonl")
	// #nosec G304,G703 -- operator-selected local simulation output, never a GitHub API path.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return LakeResult{}, err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	buffer := bufio.NewWriterSize(io.MultiWriter(file, hash), 256*1024)
	encoder := json.NewEncoder(buffer)
	result := LakeResult{Repositories: s.Repositories, Runs: s.Repositories * horizonDays * s.History.RunsPerDay}
	if err := encoder.Encode(map[string]any{
		"kind": "metadata", "schemaVersion": model.CanonicalSchemaVersion, "ingestionVersion": model.NormalizedIngestionVersion,
		"phase": "runs", "records": result.Repositories*2 + result.Runs,
	}); err != nil {
		return LakeResult{}, err
	}
	record := func(collection string, row model.Row) error {
		return encoder.Encode(map[string]any{"kind": "record", "collection": collection, "record": row})
	}
	for index := 0; index < s.Repositories; index++ {
		if err := ctx.Err(); err != nil {
			return LakeResult{}, err
		}
		name := repositoryName(index)
		repositoryID := "repository:" + name
		workflowID := "workflow:" + name + ":synthetic"
		if err := record("repositories", model.Row{
			"id": repositoryID, "owner": "simulator", "name": fmt.Sprintf("repo-%05d", index+1),
			"visibility": "public", "observedAt": s.History.AsOf,
		}); err != nil {
			return LakeResult{}, err
		}
		if err := record("workflows", model.Row{
			"id": workflowID, "repositoryId": repositoryID, "path": ".github/workflows/synthetic.md",
			"name": "Synthetic workflow", "state": "active", "role": "worker", "observedAt": s.History.AsOf,
		}); err != nil {
			return LakeResult{}, err
		}
		for offset := 0; offset < horizonDays*s.History.RunsPerDay; offset++ {
			run := s.History.Run(index, offset)
			created := run.CreatedAt.Format("2006-01-02T15:04:05Z07:00")
			if err := record("runs", model.Row{
				"id": fmt.Sprintf("run:%d", run.ID), "repositoryId": repositoryID, "workflowId": workflowID,
				"owner": "simulator", "repository": fmt.Sprintf("repo-%05d", index+1),
				"workflowPath": ".github/workflows/synthetic.md", "githubRunId": fmt.Sprint(run.ID),
				"attempt": run.Attempt, "status": run.Status, "conclusion": run.Conclusion,
				"createdAt": created, "startedAt": created, "completedAt": created, "updatedAt": created,
				"observedAt": created,
			}); err != nil {
				return LakeResult{}, err
			}
		}
	}
	if err := buffer.Flush(); err != nil {
		return LakeResult{}, err
	}
	if err := file.Close(); err != nil {
		return LakeResult{}, err
	}
	manifest, err := json.Marshal(map[string]string{"gh-aw-logs-runs/synthetic.jsonl": hex.EncodeToString(hash.Sum(nil))})
	if err != nil {
		return LakeResult{}, err
	}
	// #nosec G703 -- fixed output names under the operator-selected simulation directory.
	if err := os.WriteFile(filepath.Join(directory, "payload-hashes.json"), manifest, 0o600); err != nil {
		return LakeResult{}, err
	}
	// #nosec G703 -- fixed local simulation inventory, never remote input.
	if err := os.WriteFile(filepath.Join(directory, "inventory-sources.json"), []byte("{}\n"), 0o600); err != nil {
		return LakeResult{}, err
	}
	return result, nil
}
