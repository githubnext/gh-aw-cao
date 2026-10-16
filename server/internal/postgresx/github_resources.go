package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const GitHubResourceEntries = 256
const GitHubResourceKeepFor = 24*time.Hour + 5*time.Minute

type GitHubResource struct {
	Body         []byte
	ETag         string
	UpstreamETag string
	Validated    time.Time
}

func (s *Store) ReadGitHubResource(ctx context.Context, key string) (GitHubResource, bool, error) {
	var entry GitHubResource
	err := s.db.QueryRowContext(ctx, `SELECT
		CASE WHEN release THEN json_build_object(
			'tag_name',tag_name,'name',name,'html_url',html_url,'published_at',published_at,'draft',draft,'prerelease',prerelease)
		ELSE json_build_object(
			'full_name',full_name,'description',description,'html_url',html_url,'default_branch',default_branch,
			'stargazers_count',stargazers_count,'forks_count',forks_count,'open_issues_count',open_issues_count,
			'archived',archived,'visibility',visibility) END,
		etag,upstream_etag,validated_at
		FROM cao_github_resources WHERE namespace=$1 AND id=$2
		AND validated_at >= clock_timestamp() - interval '24 hours 5 minutes'`, s.namespace, key).
		Scan(&entry.Body, &entry.ETag, &entry.UpstreamETag, &entry.Validated)
	if errors.Is(err, sql.ErrNoRows) {
		return GitHubResource{}, false, nil
	}
	if err != nil {
		return GitHubResource{}, false, fmt.Errorf("read GitHub resource: %w", err)
	}
	// Match the exact normalized bytes used for the client ETag.
	var compact json.RawMessage
	if err := json.Unmarshal(entry.Body, &compact); err != nil {
		return GitHubResource{}, false, err
	}
	body, err := json.Marshal(compact)
	entry.Body = body
	return entry, true, err
}

func (s *Store) WriteGitHubResource(ctx context.Context, key string, entry GitHubResource) error {
	if len(key) > 512 || len(entry.Body) > 64<<10 || len(entry.ETag) > 4096 || len(entry.UpstreamETag) > 4096 {
		return errors.New("GitHub resource exceeds storage limits")
	}
	var value struct {
		FullName        *string `json:"full_name"`
		Description     *string `json:"description"`
		HTMLURL         string  `json:"html_url"`
		DefaultBranch   *string `json:"default_branch"`
		StargazersCount *int64  `json:"stargazers_count"`
		ForksCount      *int64  `json:"forks_count"`
		OpenIssuesCount *int64  `json:"open_issues_count"`
		Archived        *bool   `json:"archived"`
		Visibility      *string `json:"visibility"`
		TagName         *string `json:"tag_name"`
		Name            *string `json:"name"`
		PublishedAt     *string `json:"published_at"`
		Draft           *bool   `json:"draft"`
		Prerelease      *bool   `json:"prerelease"`
	}
	if err := json.Unmarshal(entry.Body, &value); err != nil {
		return err
	}
	if value.HTMLURL == "" || (value.FullName == nil) == (value.TagName == nil) {
		return errors.New("invalid GitHub resource")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Serialize the namespace budget across replicas, even before ingestion.
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "github-resources:"+s.namespace); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO cao_github_resources
		(namespace,id,etag,upstream_etag,validated_at,release,full_name,description,html_url,default_branch,
		stargazers_count,forks_count,open_issues_count,archived,visibility,tag_name,name,published_at,draft,prerelease)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
		ON CONFLICT (namespace,id) DO UPDATE SET etag=excluded.etag,upstream_etag=excluded.upstream_etag,
		validated_at=excluded.validated_at,release=excluded.release,full_name=excluded.full_name,
		description=excluded.description,html_url=excluded.html_url,default_branch=excluded.default_branch,
		stargazers_count=excluded.stargazers_count,forks_count=excluded.forks_count,
		open_issues_count=excluded.open_issues_count,archived=excluded.archived,visibility=excluded.visibility,
		tag_name=excluded.tag_name,name=excluded.name,published_at=excluded.published_at,draft=excluded.draft,prerelease=excluded.prerelease`,
		s.namespace, key, entry.ETag, entry.UpstreamETag, entry.Validated, value.TagName != nil,
		value.FullName, value.Description, value.HTMLURL, value.DefaultBranch, value.StargazersCount, value.ForksCount,
		value.OpenIssuesCount, value.Archived, value.Visibility, value.TagName, value.Name, value.PublishedAt, value.Draft, value.Prerelease)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cao_github_resources WHERE namespace=$1
		AND (validated_at < clock_timestamp() - interval '24 hours 5 minutes' OR id IN (
			SELECT id FROM cao_github_resources WHERE namespace=$1 ORDER BY validated_at DESC,id OFFSET $2
		))`, s.namespace, GitHubResourceEntries); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteGitHubResource(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM cao_github_resources WHERE namespace=$1 AND id=$2", s.namespace, key)
	return err
}
