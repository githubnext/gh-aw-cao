package sqlitex

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/githubnext/gh-cao/internal/dashboardquery"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func (r *reader) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	state, err := r.State(ctx)
	if err != nil {
		return model.Diagnostics{}, err
	}
	result := model.Diagnostics{
		SchemaVersion: model.SchemaVersion, Counts: map[string]int{},
		RelationshipErrors: []string{}, DuplicateRecordIDs: map[string][]string{},
	}
	for source, count := range state.Counts {
		name := strings.TrimPrefix(source, "$")
		result.Counts[name] = count
		result.DuplicateRecordIDs[name] = []string{}
	}
	if err := r.duplicates(ctx, &result); err != nil {
		return result, err
	}
	for _, relationship := range []struct{ collection, field, parent string }{
		{"workflows", "repositoryId", "repositories"}, {"runs", "repositoryId", "repositories"}, {"runs", "workflowId", "workflows"},
		{"domains", "runId", "runs"}, {"tools", "runId", "runs"}, {"skills", "runId", "runs"},
		{"friction", "runId", "runs"}, {"audits", "runId", "runs"}, {"issues", "runId", "runs"},
		{"operationalValues", "repositoryId", "repositories"}, {"experiments", "workflowId", "workflows"},
		{"operationalValueEvidence", "repositoryId", "repositories"},
		{"operationalValueEvidence", "workflowId", "workflows"},
		{"graders", "workflowId", "workflows"}, {"evals", "workflowId", "workflows"},
		{"experimentAssignments", "runId", "runs"}, {"experimentAssignments", "experimentId", "experiments"},
		{"graderObservations", "runId", "runs"}, {"graderObservations", "graderId", "graders"},
		{"evalObservations", "runId", "runs"}, {"evalObservations", "evalId", "evals"},
	} {
		failures, err := r.missingParents(ctx, relationship.collection, relationship.field, relationship.parent)
		if err != nil {
			return result, err
		}
		result.RelationshipErrors = append(result.RelationshipErrors, failures...)
	}
	sort.Strings(result.RelationshipErrors)
	return result, nil
}

func (r *reader) duplicates(ctx context.Context, result *model.Diagnostics) error {
	rows, err := r.tx.QueryContext(ctx, `SELECT store_name,json_extract(value,'$.id')
		FROM __idb_records WHERE database_name=? AND json_extract(value,'$.id') IS NOT NULL
		GROUP BY store_name,json_extract(value,'$.id') HAVING count(*)>1 ORDER BY store_name,2`,
		dashboardquery.DatabaseName)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name, id string
		if err := rows.Scan(&name, &id); err != nil {
			return err
		}
		if canonicalCollection(name) {
			result.DuplicateRecordIDs[name] = append(result.DuplicateRecordIDs[name], id)
		}
	}
	return rows.Err()
}

func (r *reader) missingParents(ctx context.Context, collection, field, parent string) ([]string, error) {
	rows, err := r.tx.QueryContext(ctx, `SELECT coalesce(json_extract(child.value,'$.id'),child.record_key)
		FROM __idb_records AS child
		WHERE child.database_name=? AND child.store_name=? AND NOT EXISTS (
			SELECT 1 FROM __idb_records AS parent WHERE parent.database_name=child.database_name
			AND parent.store_name=? AND json_extract(parent.value,'$.id')=json_extract(child.value,?))
		ORDER BY child.record_key`, dashboardquery.DatabaseName, collection, parent, "$."+field)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	failures := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		failures = append(failures, fmt.Sprintf("%s.%s references a missing %s record", id, field, parent))
	}
	return failures, rows.Err()
}
