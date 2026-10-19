package sqlitex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type inventoryRecord struct {
	row       model.Row
	overrides model.Row
}

func (s *Store) loadCompilerOverrides(content []byte) error {
	if err := json.Unmarshal(content, &s.compilerOverrides); err != nil || s.compilerOverrides == nil {
		return errors.New("native compiler overrides must be an object")
	}
	if len(s.compilerOverrides) > query.MaxInputRows {
		return errors.New("native compiler overrides exceed max input rows")
	}
	for id, fields := range s.compilerOverrides {
		if id == "" || fields == nil {
			return errors.New("native compiler overrides require workflow IDs and field objects")
		}
		for field, value := range fields {
			text, ok := value.(string)
			if !ok || text == "" {
				return errors.New("native compiler override fields must contain nonempty strings")
			}
			switch field {
			case "ghAwCurrentVersion":
			case "ghAwUpdateState":
				if text != "up-to-date" && text != "update-available" && text != "unknown" {
					return errors.New("native compiler override has an invalid update state")
				}
			default:
				return fmt.Errorf("unsupported native compiler override field %q", field)
			}
		}
	}
	return nil
}

func (s *Store) applyCompilerOverrides(row model.Row) {
	id, _ := row["id"].(string)
	for field, value := range s.compilerOverrides[id] {
		if field == "ghAwUpdateState" {
			if installed, ok := row["ghAwVersion"].(string); !ok || installed == "" {
				continue
			}
		}
		row[field] = value
	}
}

func (s *Store) normalizeInventory(ctx context.Context) error {
	s.inventoryRows = map[string][]inventoryRecord{}
	for _, collection := range []string{"campaigns", "repositories", "workflows"} {
		source, exists := s.inventory[collection]
		if !exists || source.Metadata["availability"] == "unavailable" {
			continue
		}
		if len(source.Rows) > query.MaxInputRows {
			return fmt.Errorf("inventory collection %q exceeds max input rows", collection)
		}
		for _, input := range source.Rows {
			if err := ctx.Err(); err != nil {
				return err
			}
			observation := model.Row{}
			for field, value := range input {
				observation[field] = value
			}
			if _, present := observation["observed-at"]; !present {
				if observed, ok := source.Metadata["as-of"].(string); ok && observed != "" {
					observation["observed-at"] = observed
				}
			}
			if collection == "workflows" {
				if path, ok := normalizedWorkflowPath(observation["workflow"]); ok {
					observation["workflow"] = path
				}
			}
			_, row, err := ingest.NormalizeInventoryRow(collection, observation)
			if err != nil {
				return fmt.Errorf("normalize native inventory %q: %w", collection, err)
			}
			overrides := model.Row{}
			if collection == "workflows" {
				for field, inputField := range map[string]string{
					"ghAwVersion": "gh-aw-version", "ghAwCurrentVersion": "gh-aw-current-version", "ghAwUpdateState": "gh-aw-update-state",
				} {
					if _, present := input[inputField]; present {
						overrides[field] = row[field]
					}
				}
			}
			s.inventoryRows[collection] = append(s.inventoryRows[collection], inventoryRecord{row: row, overrides: overrides})
		}
	}
	return nil
}

func normalizedWorkflowPath(value any) (string, bool) {
	path, ok := value.(string)
	if !ok {
		return "", false
	}
	path = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(path)), ".github/workflows/")
	if path == "" || strings.ContainsAny(path, "/\\") || path == "." || path == ".." {
		return "", false
	}
	if strings.HasSuffix(path, ".lock.yml") {
		path = strings.TrimSuffix(path, ".lock.yml") + ".md"
	}
	return ".github/workflows/" + path, true
}

func workflowCoordinate(row model.Row) (string, bool) {
	repository, ok := row["repositoryId"].(string)
	if !ok || !strings.HasPrefix(repository, "repository:") {
		return "", false
	}
	coordinate, err := url.PathUnescape(strings.TrimPrefix(repository, "repository:"))
	if err != nil || strings.Count(coordinate, "/") != 1 {
		return "", false
	}
	path, ok := normalizedWorkflowPath(row["path"])
	if !ok {
		return "", false
	}
	return strings.ToLower(coordinate) + ":" + path, true
}

func (s *Store) enrichInventory(collection string, rows []model.Row) ([]model.Row, error) {
	observations := s.inventoryRows[collection]
	if len(observations) == 0 {
		return rows, nil
	}
	ids, coordinates := map[string]int{}, map[string]int{}
	for i, row := range rows {
		if id, ok := row["id"].(string); ok {
			ids[id] = i
		}
		if collection == "workflows" {
			if coordinate, ok := workflowCoordinate(row); ok {
				coordinates[coordinate] = i
			}
		}
	}
	for _, observation := range observations {
		id, _ := observation.row["id"].(string)
		position, exists := ids[id]
		coordinate, validCoordinate := "", false
		if collection == "workflows" {
			coordinate, validCoordinate = workflowCoordinate(observation.row)
			position, exists = coordinates[coordinate]
			if !exists {
				// An identity-only historical placeholder is not compiler evidence.
				if _, placeholder := ids[id]; placeholder {
					continue
				}
			}
		}
		if exists {
			row := rows[position]
			for field, value := range observation.row {
				if _, present := row[field]; !present {
					row[field] = value
				}
			}
			for field, value := range observation.overrides {
				row[field] = value
			}
			continue
		}
		if len(rows) >= query.MaxInputRows {
			return nil, fmt.Errorf("canonical inventory collection %q exceeds max input rows", collection)
		}
		row := model.Row{}
		for field, value := range observation.row {
			row[field] = value
		}
		ids[id] = len(rows)
		if validCoordinate {
			coordinates[coordinate] = len(rows)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func (r *readTransaction) inventoryIdentities(ctx context.Context, collection string) ([]model.Row, error) {
	rows, err := r.tx.QueryContext(ctx, `SELECT
		json_extract(value,'$.id'),json_extract(value,'$.repositoryId'),json_extract(value,'$.path')
		FROM __idb_records WHERE database_name=? AND store_name=? LIMIT ?`,
		r.store.database, collection, query.MaxInputRows+1)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var projected []model.Row
	for rows.Next() {
		if len(projected) >= query.MaxInputRows {
			return nil, fmt.Errorf("canonical inventory collection %q exceeds max input rows", collection)
		}
		var id, repository, path any
		if err := rows.Scan(&id, &repository, &path); err != nil {
			return nil, err
		}
		projected = append(projected, model.Row{"id": id, "repositoryId": repository, "path": path})
	}
	return projected, rows.Err()
}
