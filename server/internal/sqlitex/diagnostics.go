package sqlitex

import (
	"context"
	"fmt"
	"slices"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
)

func (s *Store) Diagnostics(ctx context.Context) (diagnostics model.Diagnostics, err error) {
	err = s.WithReadTransaction(ctx, func(ctx context.Context, r postgresx.NativeReader) error {
		diagnostics, err = r.Diagnostics(ctx)
		return err
	})
	return
}

func (r *readTransaction) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	result := model.Diagnostics{
		Counts: map[string]int{}, RelationshipErrors: []string{},
		DuplicateRecordIDs: map[string][]string{},
	}
	if r.store.tables["__idb_databases"] {
		if err := r.tx.QueryRowContext(ctx, `SELECT version FROM __idb_databases WHERE name=?`, r.store.database).Scan(&result.SchemaVersion); err != nil {
			return result, err
		}
	}
	state, err := r.State(ctx)
	if err != nil {
		return result, err
	}
	for _, collection := range collections {
		result.Counts[collection] = state.Counts["$"+collection]
		result.DuplicateRecordIDs[collection] = []string{}
	}
	type reference struct {
		id, repository, campaign, workflow, run, experiment, grader, eval, path string
		campaignSet                                                             bool
	}
	records := map[string][]reference{}
	index := map[string]map[string]reference{}
	addReference := func(collection string, record reference) {
		if index[collection] == nil {
			index[collection] = map[string]reference{}
		}
		if _, exists := index[collection][record.id]; exists {
			result.DuplicateRecordIDs[collection] = append(result.DuplicateRecordIDs[collection], record.id)
		}
		index[collection][record.id] = record
		records[collection] = append(records[collection], record)
	}
	rows, err := r.tx.QueryContext(ctx, `SELECT store_name,
		coalesce(json_extract(value,'$.id'),'<unknown>'),
		coalesce(json_extract(value,'$.repositoryId'),''),
		coalesce(json_extract(value,'$.campaignId'),''),
		coalesce(json_extract(value,'$.workflowId'),''),
		coalesce(json_extract(value,'$.runId'),''),
		coalesce(json_extract(value,'$.experimentId'),''),
		coalesce(json_extract(value,'$.graderId'),''),
		coalesce(json_extract(value,'$.evalId'),''),
		coalesce(json_extract(value,'$.path'),''),
		(json_type(value,'$.campaignId') IS NOT NULL AND json_type(value,'$.campaignId') <> 'null')
		FROM __idb_records WHERE database_name=? ORDER BY store_name,record_key`, r.store.database)
	if err != nil {
		return result, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var collection string
		var record reference
		if err := rows.Scan(&collection, &record.id, &record.repository, &record.campaign, &record.workflow,
			&record.run, &record.experiment, &record.grader, &record.eval, &record.path, &record.campaignSet); err != nil {
			return result, err
		}
		if !slices.Contains(collections, collection) {
			continue
		}
		addReference(collection, record)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	for collection, inventory := range r.store.inventoryRows {
		if len(inventory) == 0 {
			continue
		}
		projected := make([]model.Row, 0, len(records[collection]))
		for _, record := range records[collection] {
			row := model.Row{"id": record.id, "repositoryId": record.repository, "path": record.path}
			if record.campaignSet {
				row["campaignId"] = record.campaign
			}
			projected = append(projected, row)
		}
		enriched, err := r.store.enrichInventory(collection, projected)
		if err != nil {
			return result, err
		}
		records[collection], index[collection] = nil, nil
		result.DuplicateRecordIDs[collection] = []string{}
		for _, row := range enriched {
			id, _ := row["id"].(string)
			repository, _ := row["repositoryId"].(string)
			campaign, campaignSet := row["campaignId"].(string)
			path, _ := row["path"].(string)
			addReference(collection, reference{id: id, repository: repository, campaign: campaign, path: path, campaignSet: campaignSet})
		}
	}
	require := func(record reference, field, id, collection, entity string) {
		if _, exists := index[collection][id]; id == "" || !exists {
			result.RelationshipErrors = append(result.RelationshipErrors,
				fmt.Sprintf("%s.%s does not reference an existing %s", record.id, field, entity))
		}
	}
	for _, record := range records["workflows"] {
		require(record, "repositoryId", record.repository, "repositories", "repository")
		if record.campaignSet {
			require(record, "campaignId", record.campaign, "campaigns", "campaign")
		}
	}
	for _, record := range records["runs"] {
		require(record, "repositoryId", record.repository, "repositories", "repository")
		require(record, "workflowId", record.workflow, "workflows", "workflow")
		if workflow, exists := index["workflows"][record.workflow]; exists && workflow.repository != record.repository {
			result.RelationshipErrors = append(result.RelationshipErrors, record.id+".workflowId references a workflow from another repository")
		}
	}
	for _, collection := range []string{"domains", "tools", "skills", "friction", "audits", "issues"} {
		for _, record := range records[collection] {
			require(record, "runId", record.run, "runs", "run")
		}
	}
	for _, record := range records["operationalValues"] {
		require(record, "repositoryId", record.repository, "repositories", "repository")
	}
	for _, collection := range []string{"experiments", "graders", "evals"} {
		for _, record := range records[collection] {
			require(record, "workflowId", record.workflow, "workflows", "workflow")
		}
	}
	for _, spec := range []struct{ collection, parent, field string }{
		{"experimentAssignments", "experiments", "experimentId"},
		{"graderObservations", "graders", "graderId"},
		{"evalObservations", "evals", "evalId"},
	} {
		for _, record := range records[spec.collection] {
			require(record, "runId", record.run, "runs", "run")
			id := record.experiment
			switch spec.field {
			case "graderId":
				id = record.grader
			case "evalId":
				id = record.eval
			}
			parent, parentExists := index[spec.parent][id]
			if !parentExists {
				result.RelationshipErrors = append(result.RelationshipErrors,
					record.id+"."+spec.field+" does not reference a definition")
			}
			if run, exists := index["runs"][record.run]; exists && parentExists && run.workflow != parent.workflow {
				result.RelationshipErrors = append(result.RelationshipErrors,
					record.id+"."+spec.field+" references a different workflow")
			}
		}
	}
	return result, nil
}
