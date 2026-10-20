package collect

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operationalvalue"
	"github.com/githubnext/gh-cao/server/internal/postgresx"
)

// CollectWorkflowValues uses the existing projection driver's tick even when a
// quiet repository produced no new run artifacts. The projection lease excludes
// snapshot replacement and another collector; this is not a second scheduler.
func (p Projector) CollectWorkflowValues(ctx context.Context) (int64, error) {
	if p.Data == nil || p.Leases == nil || p.CatalogRoot == "" || p.PolicyPath == "" || p.Tokens == nil {
		return 0, nil
	}
	token, err := operationToken()
	if err != nil {
		return 0, err
	}
	acquired, err := p.Leases.TryLock(ctx, projectionLockName, token, p.lockTTL())
	if err != nil {
		return 0, err
	}
	if !acquired {
		return 0, ErrProjectionBusy
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = p.Leases.Unlock(release, projectionLockName, token)
	}()
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	return p.refreshWorkflowValues(ctx)
}

// Recurring rich packets use the same reviewed Node producer as Activity and
// the same atomic publication boundary as manual uploads, never HTTP sessions.
func (p Projector) refreshWorkflowValues(ctx context.Context) (revision int64, err error) {
	if p.CatalogRoot == "" || p.PolicyPath == "" || p.Tokens == nil {
		return revision, nil
	}
	config := operationalvalue.Config{
		Root: p.CatalogRoot, NodeBinary: p.node(), GitHubBinary: p.GitHubBinary,
		ObservedAt: time.Now().UTC(), Environment: collectionEnvironment(p.GitHubAPIURL),
	}
	entries, err := operationalvalue.WorkflowRegistrations(ctx, config, p.PolicyPath)
	if err != nil || len(entries) == 0 {
		return revision, err
	}
	repositories, err := p.enrolledRepositories(ctx)
	if err != nil {
		return revision, err
	}
	enrolled := map[string]bool{}
	for _, repository := range repositories {
		enrolled[strings.ToLower(repository)] = true
	}
	workspace := filepath.Join(p.Lake.Directory, "workflow-value-workspaces")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return revision, err
	}
	scratch, err := os.MkdirTemp(workspace, ".projection-")
	if err != nil {
		return revision, err
	}
	defer func() { _ = os.RemoveAll(scratch) }()
	config.Database = filepath.Join(scratch, "activity.sqlite")
	retention := strconv.Itoa(p.windowDays())
	if err := p.run(ctx, []string{
		filepath.Join(p.CatalogRoot, "activity", "cao.mjs"), "ingest-jsonl",
		"--database", config.Database, "--runs-dir", p.Lake.RunsDirectory(),
		"--records-dir", p.Lake.RecordsDirectory(), "--retention-days", retention,
		"--run-retention-days", retention,
	}); err != nil {
		return revision, err
	}
	grouped := map[string][]operationalvalue.WorkflowRegistration{}
	for _, entry := range entries {
		if enrolled[strings.ToLower(entry.Repository)] {
			grouped[strings.ToLower(entry.Repository)] = append(grouped[strings.ToLower(entry.Repository)], entry)
		}
	}
	for repository, registrations := range grouped {
		installation, err := p.Enrollment.InstallationFor(ctx, repository)
		if err != nil || installation <= 0 {
			return revision, errors.New("workflow Value repository installation is unavailable")
		}
		reserve, err := p.rateLimitReserve(ctx, installation)
		if err != nil {
			return revision, err
		}
		token, err := p.Tokens.InstallationToken(ctx, installation)
		if err != nil {
			return revision, err
		}
		previous := []byte{}
		for _, entry := range registrations {
			packet, err := p.Data.ReadOperationalValue(ctx, repository, entry.Workflow)
			if errors.Is(err, postgresx.ErrValueNotFound) || errors.Is(err, postgresx.ErrValueParentMissing) {
				continue
			}
			if err != nil {
				return revision, err
			}
			content, err := json.Marshal(map[string]any{
				"schema_version": 2, "kind": "operational_value_evidence", "operational_value_evidence": packet,
			})
			if err != nil {
				return revision, err
			}
			previous = append(previous, content...)
			previous = append(previous, '\n')
		}
		previousPath := filepath.Join(scratch, "previous.jsonl")
		if err := os.WriteFile(previousPath, previous, 0o600); err != nil {
			return revision, err
		}
		config.Repositories = []string{repository}
		config.RateLimitReserve = reserve
		config.Environment = append(collectionEnvironment(p.GitHubAPIURL),
			"GH_TOKEN="+token, "CAO_OPERATIONAL_VALUE_GH_TOKEN="+token,
			"CAO_GITHUB_API_MIN_REMAINING="+strconv.Itoa(reserve))
		config.RedactValues = []string{token}
		packets, warnings, err := operationalvalue.CollectWorkflows(ctx, config, p.PolicyPath, workspace, previousPath)
		if err != nil {
			projectorLog.Printf("workflow Value acquisition failed; retaining accepted evidence")
			continue
		}
		if len(warnings) > 0 {
			projectorLog.Printf("workflow Value acquisition incomplete count=%d", len(warnings))
		}
		for _, packet := range packets {
			publication, err := p.Data.PublishOperationalValue(ctx, packet)
			if err != nil {
				projectorLog.Printf("workflow Value publication rejected; retaining accepted evidence")
			} else if publication.Updated {
				revision = publication.Revision
			}
		}
	}
	return revision, nil
}
