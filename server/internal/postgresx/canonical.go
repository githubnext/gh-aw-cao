package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// These native columns cover common, stable scalar fields from the normalizer
// and producers. normalize/index.js spreads observation.data, so no canonical
// collection is treated as closed; additional attributes remain in extension.
// Presence is independent of SQL NULL to distinguish absent from observed null.
// TODO: Catalogue remaining run-linked and operational-value producer fields
// before claiming native coverage for every known canonical attribute.
var canonicalFields = []struct {
	key, column string
}{
	{"id", "id"}, {"runId", "run_id"}, {"sessionId", "session_id"},
	{"repositoryId", "repository_id"}, {"workflowId", "workflow_id"},
	{"status", "status"}, {"conclusion", "conclusion"}, {"event", "event"},
	{"owner", "owner"}, {"repository", "repository"}, {"name", "name"},
	{"fullName", "full_name"}, {"path", "path"}, {"visibility", "visibility"},
	{"state", "state"}, {"campaign", "campaign"}, {"campaignId", "campaign_id"},
	{"headSha", "head_sha"}, {"headBranch", "head_branch"},
	{"source", "source"}, {"sourceId", "source_id"},
	{"repositoryFullName", "repository_full_name"}, {"slug", "slug"},
	{"url", "url"}, {"type", "type"}, {"category", "category"},
	{"correlationId", "correlation_id"},
	{"description", "description"}, {"icon", "icon"}, {"mode", "mode"},
	{"domain", "domain"}, {"decision", "decision"},
	{"toolType", "tool_type"}, {"mcpServer", "mcp_server"}, {"mcpTool", "mcp_tool"},
	{"safeOutputType", "safe_output_type"}, {"githubEntityType", "github_entity_type"},
	{"summary", "summary"}, {"payloadRef", "payload_ref"},
	{"targetRepo", "target_repo"}, {"targetOrganization", "target_organization"},
	{"targetRepository", "target_repository"},
	{"rolloutMode", "rollout_mode"}, {"campaignName", "campaign_name"},
	{"campaignIcon", "campaign_icon"}, {"role", "role"},
	{"workflowPath", "workflow_path"}, {"title", "title"}, {"branch", "branch"},
	{"engine", "engine"}, {"engineVersion", "engine_version"},
	{"requestedModel", "requested_model"}, {"resolvedModel", "resolved_model"},
	{"modelId", "model_id"},
}

var canonicalTimes = []struct {
	key, column string
}{
	{"createdAt", "created_at"}, {"startedAt", "started_at"},
	{"completedAt", "completed_at"}, {"updatedAt", "updated_at"},
	{"observedAt", "observed_at"}, {"timestamp", "timestamp_at"},
}

var canonicalNumbers = []struct {
	key, column string
}{
	{"attempt", "attempt"}, {"sequence", "sequence"},
	{"number", "issue_number"}, {"durationMs", "duration_ms"},
	{"requestCount", "request_count"},
	{"workerCount", "worker_count"}, {"aicTotal", "aic_total"},
}

// PostgreSQL NUMERIC preserves ordinary decimal scale, but normalizes
// exponent notation and negative zero; exceptional values need the lexeme.
func numericRawLexeme(text string, native any) any {
	if native == nil || strings.ContainsAny(text, "eE") || text == "-0" ||
		(strings.HasPrefix(text, "-0.") && strings.Trim(text[3:], "0") == "") {
		return text
	}
	return nil
}

var canonicalBooleans = []struct {
	key, column string
}{
	{"enabled", "enabled"}, {"isSkill", "is_skill"},
	{"isPullRequest", "is_pull_request"},
}

// Producer identifiers may be numeric or textual; do not stringify a JSON
// number or turn a textual identifier into a number on round-trip.
var canonicalIdentifiers = []struct {
	key, column string
}{
	{"githubId", "github_id"}, {"githubRunId", "github_run_id"},
}

var canonicalLinks = []struct {
	key, column string
}{
	{"organizationLink", "organization_href"}, {"repositoryLink", "repository_href"},
	{"workflowLink", "workflow_href"}, {"runLink", "run_href"},
}

// Mirrors ingest.collections. Inventory names, even names beginning with "$",
// are not implicitly canonical and retain their arbitrary source shape.
var canonicalCollections = map[string]bool{
	"$campaigns": true, "$repositories": true, "$workflows": true, "$runs": true,
	"$jobs": true, "$sessions": true, "$events": true,
	"$domains": true, "$tools": true, "$skills": true, "$friction": true,
	"$audits": true, "$issues": true, "$operationalValues": true,
	"$experiments": true, "$experimentAssignments": true,
	"$graders": true, "$graderObservations": true,
	"$evals": true, "$evalObservations": true,
}

func isCanonicalSource(name string) bool { return canonicalCollections[name] }

func isCanonicalTextField(name string) bool {
	for _, field := range canonicalFields {
		if field.key == name {
			return true
		}
	}
	return false
}

func canonicalFallbackReason(row model.Row) string {
	for _, field := range canonicalFields {
		if value := row[field.key]; value != nil {
			if _, ok := value.(string); !ok {
				return fmt.Sprintf("known field %s has unsupported type %T", field.key, value)
			}
		}
	}
	for _, field := range canonicalTimes {
		if value := row[field.key]; value != nil {
			text, ok := value.(string)
			if !ok {
				return fmt.Sprintf("known timestamp %s has unsupported type %T", field.key, value)
			}
			if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
				return fmt.Sprintf("known timestamp %s has invalid format", field.key)
			}
		}
	}
	for _, field := range canonicalNumbers {
		if value := row[field.key]; value != nil {
			if _, ok := value.(json.Number); !ok {
				return fmt.Sprintf("known number %s has unsupported type %T", field.key, value)
			}
		}
	}
	for _, field := range canonicalBooleans {
		if value := row[field.key]; value != nil {
			if _, ok := value.(bool); !ok {
				return fmt.Sprintf("known boolean %s has unsupported type %T", field.key, value)
			}
		}
	}
	for _, field := range canonicalIdentifiers {
		switch value := row[field.key].(type) {
		case nil, string, json.Number:
		default:
			return fmt.Sprintf("known identifier %s has unsupported type %T", field.key, value)
		}
	}
	for _, field := range canonicalLinks {
		if value := row[field.key]; value != nil {
			link, ok := value.(map[string]any)
			if !ok || len(link) != 1 {
				return fmt.Sprintf("known link %s has unsupported shape", field.key)
			}
			if _, ok := link["href"].(string); !ok {
				return fmt.Sprintf("known link %s has unsupported href", field.key)
			}
		}
	}
	return "known field has unsupported representation"
}

func timestampReadExpression(column string) string {
	utc := "(" + column + " AT TIME ZONE 'UTC')"
	return `COALESCE(` + column + `_raw, CASE WHEN ` + column + ` IS NULL THEN NULL ELSE
		to_char(` + utc + `, 'YYYY-MM-DD"T"HH24:MI:SS') ||
		CASE WHEN to_char(` + utc + `, 'US') = '000000' THEN '' ELSE
			'.' || rtrim(to_char(` + utc + `, 'US'), '0') END || 'Z' END)`
}

func canonicalRow(row model.Row) (fields []string, values []any, extension string, ok bool, err error) {
	rest := make(model.Row, len(row))
	for k, v := range row {
		rest[k] = v
	}
	values = make([]any, 0, len(canonicalFields)+2*(len(canonicalTimes)+len(canonicalNumbers))+len(canonicalBooleans)+3*len(canonicalIdentifiers)+len(canonicalLinks))
	for _, field := range canonicalFields {
		v, present := rest[field.key]
		if present && v != nil {
			text, isString := v.(string)
			if !isString {
				return nil, nil, "", false, nil
			}
			values = append(values, text)
		} else {
			values = append(values, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalTimes {
		v, present := rest[field.key]
		if present && v != nil {
			text, isString := v.(string)
			if !isString {
				return nil, nil, "", false, nil
			}
			instant, parseErr := time.Parse(time.RFC3339Nano, text)
			if parseErr != nil {
				return nil, nil, "", false, nil
			}
			var lexical any
			if instant.Nanosecond()%1000 != 0 || instant.UTC().Format(time.RFC3339Nano) != text {
				lexical = text
			}
			values = append(values, instant, lexical)
		} else {
			values = append(values, nil, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalNumbers {
		v, present := rest[field.key]
		if present && v != nil {
			number, valid := v.(json.Number)
			if !valid {
				return nil, nil, "", false, nil
			}
			text := string(number)
			_, parseErr := strconv.ParseFloat(text, 64)
			if parseErr != nil && !strings.Contains(parseErr.Error(), "value out of range") {
				return nil, nil, "", false, nil
			}
			var numeric any
			if len(text) <= 1000 {
				exponent := 0
				var exponentErr error
				if pos := strings.IndexAny(text, "eE"); pos >= 0 {
					exponent, exponentErr = strconv.Atoi(text[pos+1:])
				}
				if exponentErr == nil && exponent >= -1000 && exponent <= 1000 {
					numeric = text
				}
			}
			values = append(values, numeric, numericRawLexeme(text, numeric))
		} else {
			values = append(values, nil, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalBooleans {
		v, present := rest[field.key]
		if present && v != nil {
			boolean, isBoolean := v.(bool)
			if !isBoolean {
				return nil, nil, "", false, nil
			}
			values = append(values, boolean)
		} else {
			values = append(values, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalIdentifiers {
		v, present := rest[field.key]
		switch identifier := v.(type) {
		case nil:
			values = append(values, nil, nil, nil)
		case string:
			values = append(values, identifier, "string", nil)
		case json.Number:
			text := string(identifier)
			var native any
			if len(text) <= 1000 {
				exponent := 0
				var exponentErr error
				if pos := strings.IndexAny(text, "eE"); pos >= 0 {
					exponent, exponentErr = strconv.Atoi(text[pos+1:])
				}
				if exponentErr == nil && exponent >= -1000 && exponent <= 1000 {
					native = text
				}
			}
			values = append(values, numericRawLexeme(text, native), "number", native)
		default:
			return nil, nil, "", false, nil
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalLinks {
		v, present := rest[field.key]
		if v == nil {
			values = append(values, nil)
		} else {
			link, isObject := v.(map[string]any)
			if !isObject || len(link) != 1 {
				return nil, nil, "", false, nil
			}
			href, isString := link["href"].(string)
			if !isString {
				return nil, nil, "", false, nil
			}
			values = append(values, href)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	sort.Strings(fields)
	raw, err := json.Marshal(rest)
	if err != nil {
		return nil, nil, "", false, err
	}
	return fields, values, string(raw), true, nil
}

func insertCanonical(ctx context.Context, tx *sql.Tx, namespace, name string, ordinal int64, row model.Row) (bool, error) {
	fields, values, extension, ok, err := canonicalRow(row)
	if err != nil || !ok {
		return ok, err
	}
	columns := []string{"namespace", "source_name", "ordinal", "present", "extension"}
	args := []any{namespace, name, ordinal, fields, extension}
	for _, field := range canonicalFields {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalTimes {
		columns = append(columns, field.column, field.column+"_raw")
	}
	for _, field := range canonicalNumbers {
		columns = append(columns, field.column, field.column+"_raw")
	}
	for _, field := range canonicalBooleans {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalIdentifiers {
		columns = append(columns, field.column, field.column+"_kind", field.column+"_numeric")
	}
	for _, field := range canonicalLinks {
		columns = append(columns, field.column)
	}
	args = append(args, values...)
	placeholders := make([]string, len(args))
	for i := range args {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	// The schema-owned identifiers above are constants, not user input.
	statement := `INSERT INTO cao_canonical_rows (` + strings.Join(columns, ",") +
		`) VALUES (` + strings.Join(placeholders, ",") + `)`
	_, err = tx.ExecContext(ctx, statement, args...)
	return true, err
}

func readCanonical(ctx context.Context, tx *sql.Tx, namespace, name string) ([]model.Row, bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = $1 AND source_name = $2`, namespace, name).Scan(&count)
	if err != nil || count == 0 {
		return nil, false, err
	}
	return readCanonicalData(ctx, tx, namespace, name, count)
}

func canonicalFilter(namespace, name string, filter map[string]string) (string, []any) {
	where := `namespace = $1 AND source_name = $2`
	args := []any{namespace, name}
	for _, field := range canonicalFields {
		if value, ok := filter[field.key]; ok {
			args = append(args, value)
			where += fmt.Sprintf(" AND %s = $%d", field.column, len(args))
		}
	}
	return where, args
}

func (r *readTransaction) canonicalPlanRows(ctx context.Context, raw string, filters map[string]string,
	selected []query.SelectedField, count int, remaining int64, queryID string) ([]model.Row, error) {
	where, args := canonicalFilter(r.store.namespace, raw, filters)
	if len(selected) == 0 {
		// Filter and limit run in PostgreSQL, not against the materialized
		// source. This path reconstructs only the bounded result rows.
		columns := []string{"present", "extension"}
		for _, field := range canonicalFields {
			columns = append(columns, field.column)
		}
		for _, field := range canonicalTimes {
			columns = append(columns, timestampReadExpression(field.column))
		}
		for _, field := range canonicalNumbers {
			columns = append(columns, `COALESCE(`+field.column+`_raw, `+field.column+`::text)`)
		}
		for _, field := range canonicalBooleans {
			columns = append(columns, field.column)
		}
		for _, field := range canonicalIdentifiers {
			columns = append(columns, `COALESCE(`+field.column+`, `+field.column+`_numeric::text)`, field.column+"_kind")
		}
		for _, field := range canonicalLinks {
			columns = append(columns, field.column)
		}
		args = append(args, count+1)
		rows, err := r.tx.QueryContext(ctx, `SELECT `+strings.Join(columns, ",")+`
						FROM cao_canonical_rows WHERE `+where+` ORDER BY ordinal LIMIT $`+fmt.Sprint(len(args)), args...)
		if err != nil {
			return nil, err
		}
		defer func() { _ = rows.Close() }()
		result := make([]model.Row, 0, count)
		var size int64
		for rows.Next() {
			if len(result) == count {
				return nil, fmt.Errorf("postgres plan row count changed")
			}
			var present []string
			var extension string
			values := make([]sql.NullString, len(canonicalFields)+len(canonicalTimes)+len(canonicalNumbers))
			booleanValues := make([]sql.NullBool, len(canonicalBooleans))
			identifierValues := make([]sql.NullString, 2*len(canonicalIdentifiers))
			linkValues := make([]sql.NullString, len(canonicalLinks))
			dest := []any{&present, &extension}
			for i := range values {
				dest = append(dest, &values[i])
			}
			for i := range booleanValues {
				dest = append(dest, &booleanValues[i])
			}
			for i := range identifierValues {
				dest = append(dest, &identifierValues[i])
			}
			for i := range linkValues {
				dest = append(dest, &linkValues[i])
			}
			if err := rows.Scan(dest...); err != nil {
				return nil, err
			}
			var row model.Row
			if err := decodeJSON([]byte(extension), &row); err != nil || row == nil {
				return nil, fmt.Errorf("invalid postgres canonical extension")
			}
			for _, key := range present {
				found := false
				for i, field := range canonicalFields {
					if key == field.key {
						found = true
						if values[i].Valid {
							row[key] = values[i].String
						} else {
							row[key] = nil
						}
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalTimes {
					if key == field.key {
						if values[len(canonicalFields)+i].Valid {
							row[key] = values[len(canonicalFields)+i].String
						} else {
							row[key] = nil
						}
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalNumbers {
					if key == field.key {
						raw := values[len(canonicalFields)+len(canonicalTimes)+i]
						if raw.Valid {
							row[key] = json.Number(raw.String)
						} else {
							row[key] = nil
						}
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalBooleans {
					if key == field.key {
						if booleanValues[i].Valid {
							row[key] = booleanValues[i].Bool
						} else {
							row[key] = nil
						}
						break
					}
				}
				for i, field := range canonicalIdentifiers {
					if key == field.key {
						row[key] = decodeCanonicalIdentifier(identifierValues[2*i], identifierValues[2*i+1])
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalLinks {
					if key == field.key {
						row[key] = decodeCanonicalLink(linkValues[i])
						break
					}
				}
			}
			size += query.EstimateRowsBytes([]model.Row{row})
			if size > remaining {
				return nil, &query.PlanLimitError{QueryID: queryID, Boundary: query.BoundaryRetainedBytes}
			}
			result = append(result, row)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(result) != count {
			return nil, fmt.Errorf("postgres plan row count changed")
		}
		return result, nil
	}
	// SQL projects both relational fields and open extension attributes.
	expressions := make([]string, len(selected))
	for i, field := range selected {
		column := ""
		for _, known := range canonicalFields {
			if field.Field == known.key {
				column = known.column
			}
		}
		for _, known := range canonicalTimes {
			if field.Field == known.key {
				column = timestampReadExpression(known.column)
			}
		}
		for _, known := range canonicalNumbers {
			if field.Field == known.key {
				column = known.column + "_raw"
			}
		}
		for _, known := range canonicalBooleans {
			if field.Field == known.key {
				column = known.column
			}
		}
		identifier := false
		for _, known := range canonicalIdentifiers {
			if field.Field == known.key {
				column, identifier = known.column, true
			}
		}
		link := false
		for _, known := range canonicalLinks {
			if field.Field == known.key {
				column, link = known.column, true
			}
		}
		args = append(args, field.Field)
		if column != "" {
			if link {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
					CASE WHEN %s IS NULL THEN 'null' ELSE json_build_object('href', %s)::text END END`,
					len(args), column, column)
			} else if identifier {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
					CASE WHEN %s_kind = 'number' THEN COALESCE(%s, %s_numeric::text, 'null')
					ELSE COALESCE(to_json(%s)::text, 'null') END END`,
					len(args), column, column, column, column)
			} else if numeric := isCanonicalNumber(field.Field); numeric {
				native := strings.TrimSuffix(column, "_raw")
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
					COALESCE(%s, %s::text, 'null') END`, len(args), column, native)
			} else {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN COALESCE(to_json(%s)::text, 'null') END`, len(args), column)
			}
		} else {
			expressions[i] = fmt.Sprintf(`(extension -> $%d)::text`, len(args))
		}
	}
	args = append(args, count+1)
	rows, err := r.tx.QueryContext(ctx, `SELECT `+strings.Join(expressions, ",")+`
					FROM cao_canonical_rows WHERE `+where+` ORDER BY ordinal LIMIT $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := make([]model.Row, 0, count)
	var size int64
	for rows.Next() {
		if len(result) == count {
			return nil, fmt.Errorf("postgres plan row count changed")
		}
		values := make([]sql.NullString, len(selected))
		dest := make([]any, len(selected))
		for i := range dest {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		row := make(model.Row)
		for i, field := range selected {
			if !values[i].Valid {
				continue
			}
			var value any
			if err := decodeJSON([]byte(values[i].String), &value); err != nil {
				return nil, err
			}
			key := field.Field
			if field.As != "" {
				key = field.As
			}
			row[key] = value
		}
		size += query.EstimateRowsBytes([]model.Row{row})
		if size > remaining {
			return nil, &query.PlanLimitError{QueryID: queryID, Boundary: query.BoundaryRetainedBytes}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) != count {
		return nil, fmt.Errorf("postgres plan row count changed")
	}
	return result, nil
}

func isCanonicalNumber(field string) bool {
	for _, known := range canonicalNumbers {
		if known.key == field {
			return true
		}
	}
	return false
}

// Backfill only complete, document-backed sources. Legacy EAV-only revisions
// remain readable until the next replacement. Each source is staged behind a
// savepoint, so a nonconforming row cannot leave a half-converted source.
func backfillCanonical(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT s.namespace, s.source_name
			FROM cao_sources s JOIN cao_counts c
			ON c.namespace = s.namespace AND c.source_name = s.source_name
			WHERE s.source_name LIKE '$%' AND c.count > 0
			AND EXISTS (SELECT 1 FROM cao_source_documents m
				WHERE m.namespace = s.namespace AND m.source_name = s.source_name AND m.ordinal = -1)
			AND (SELECT count(*) FROM cao_source_documents d
				WHERE d.namespace = s.namespace AND d.source_name = s.source_name AND d.ordinal >= 0) = c.count
			AND NOT EXISTS (SELECT 1 FROM cao_canonical_rows r
				WHERE r.namespace = s.namespace AND r.source_name = s.source_name)`)
	if err != nil {
		return err
	}
	var sources [][2]string
	for rows.Next() {
		var pair [2]string
		if err = rows.Scan(&pair[0], &pair[1]); err != nil {
			break
		}
		sources = append(sources, pair)
	}
	if err == nil {
		err = rows.Err()
	}
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, source := range sources {
		namespace, name := source[0], source[1]
		if !isCanonicalSource(name) {
			continue
		}
		if _, err = tx.ExecContext(ctx, "SAVEPOINT canonical_backfill"); err != nil {
			return err
		}
		// A source-specific cursor keeps migration memory bounded and allows
		// inserts after closing each fetched batch of rows.
		if _, err = tx.ExecContext(ctx, `DECLARE canonical_backfill_cursor NO SCROLL CURSOR FOR
				SELECT ordinal, payload FROM cao_source_documents
				WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0 ORDER BY ordinal`, namespace, name); err != nil {
			return err
		}
		compatible := true
		fallbackReason := ""
		for {
			batch, fetchErr := tx.QueryContext(ctx, "FETCH FORWARD 256 FROM canonical_backfill_cursor")
			if fetchErr != nil {
				return fetchErr
			}
			type item struct {
				ordinal int64
				row     model.Row
			}
			var items []item
			for batch.Next() {
				var ordinal int64
				var payload string
				if err = batch.Scan(&ordinal, &payload); err != nil {
					break
				}
				var row model.Row
				if err = decodeJSON([]byte(payload), &row); err != nil {
					break
				}
				items = append(items, item{ordinal, row})
			}
			if err == nil {
				err = batch.Err()
			}
			_ = batch.Close()
			if err != nil {
				return err
			}
			if len(items) == 0 {
				break
			}
			for _, item := range items {
				var ok bool
				if ok, err = insertCanonical(ctx, tx, namespace, name, item.ordinal, item.row); err != nil {
					return err
				}
				if !ok {
					compatible = false
					fallbackReason = canonicalFallbackReason(item.row)
					break
				}
			}
			if !compatible {
				break
			}
		}
		if !compatible {
			// Rolling back also closes the cursor.
			if _, err = tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT canonical_backfill"); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `UPDATE cao_sources SET storage_fallback_reason = $1
				WHERE namespace = $2 AND source_name = $3`, fallbackReason, namespace, name); err != nil {
				return err
			}
		} else {
			if _, err = tx.ExecContext(ctx, "CLOSE canonical_backfill_cursor"); err != nil {
				return err
			}
			for _, statement := range []string{
				`DELETE FROM cao_source_rows WHERE namespace = $1 AND source_name = $2`,
				`DELETE FROM cao_values WHERE namespace = $1 AND source_name = $2`,
				`DELETE FROM cao_source_documents WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0`,
			} {
				if _, err = tx.ExecContext(ctx, statement, namespace, name); err != nil {
					return err
				}
			}
			if _, err = tx.ExecContext(ctx, `UPDATE cao_sources SET is_canonical = TRUE, storage_fallback_reason = NULL
				WHERE namespace = $1 AND source_name = $2`, namespace, name); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "RELEASE SAVEPOINT canonical_backfill"); err != nil {
			return err
		}
	}
	return nil
}

func decodeCanonicalIdentifier(value, kind sql.NullString) any {
	if !value.Valid {
		return nil
	}
	if kind.String == "number" {
		return json.Number(value.String)
	}
	return value.String
}

func decodeCanonicalLink(href sql.NullString) any {
	if !href.Valid {
		return nil
	}
	return map[string]any{"href": href.String}
}

func readCanonicalData(ctx context.Context, tx *sql.Tx, namespace, name string, count int) ([]model.Row, bool, error) {
	columns := []string{"present", "extension"}
	for _, field := range canonicalFields {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalTimes {
		columns = append(columns, timestampReadExpression(field.column))
	}
	for _, field := range canonicalNumbers {
		columns = append(columns, `COALESCE(`+field.column+`_raw, `+field.column+`::text)`)
	}
	for _, field := range canonicalBooleans {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalIdentifiers {
		columns = append(columns, `COALESCE(`+field.column+`, `+field.column+`_numeric::text)`, field.column+"_kind")
	}
	for _, field := range canonicalLinks {
		columns = append(columns, field.column)
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+strings.Join(columns, ",")+`
		FROM cao_canonical_rows WHERE namespace = $1 AND source_name = $2
		ORDER BY ordinal`, namespace, name)
	if err != nil {
		return nil, true, err
	}
	defer func() { _ = rows.Close() }()
	out := make([]model.Row, 0, count)
	for rows.Next() {
		var present []string
		var extension string
		values := make([]sql.NullString, len(canonicalFields)+len(canonicalTimes)+len(canonicalNumbers))
		booleanValues := make([]sql.NullBool, len(canonicalBooleans))
		identifierValues := make([]sql.NullString, 2*len(canonicalIdentifiers))
		linkValues := make([]sql.NullString, len(canonicalLinks))
		dest := []any{&present, &extension}
		for i := range values {
			dest = append(dest, &values[i])
		}
		for i := range booleanValues {
			dest = append(dest, &booleanValues[i])
		}
		for i := range identifierValues {
			dest = append(dest, &identifierValues[i])
		}
		for i := range linkValues {
			dest = append(dest, &linkValues[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, true, err
		}
		var row model.Row
		if err := decodeJSON([]byte(extension), &row); err != nil || row == nil {
			return nil, true, fmt.Errorf("invalid postgres canonical extension")
		}
		known := make(map[string]bool, len(present))
		for _, key := range present {
			known[key] = true
		}
		for i, field := range canonicalFields {
			if known[field.key] {
				if values[i].Valid {
					row[field.key] = values[i].String
				} else {
					row[field.key] = nil
				}
			}
		}
		for i, field := range canonicalTimes {
			if known[field.key] {
				if values[len(canonicalFields)+i].Valid {
					row[field.key] = values[len(canonicalFields)+i].String
				} else {
					row[field.key] = nil
				}
			}
		}
		for i, field := range canonicalNumbers {
			if known[field.key] {
				raw := values[len(canonicalFields)+len(canonicalTimes)+i]
				if raw.Valid {
					row[field.key] = json.Number(raw.String)
				} else {
					row[field.key] = nil
				}
			}
			for i, field := range canonicalBooleans {
				if known[field.key] {
					if booleanValues[i].Valid {
						row[field.key] = booleanValues[i].Bool
					} else {
						row[field.key] = nil
					}
					for i, field := range canonicalIdentifiers {
						if known[field.key] {
							row[field.key] = decodeCanonicalIdentifier(identifierValues[2*i], identifierValues[2*i+1])
						}
					}
					for i, field := range canonicalLinks {
						if known[field.key] {
							row[field.key] = decodeCanonicalLink(linkValues[i])
						}
					}
				}
			}
		}
		out = append(out, row)
	}
	return out, true, rows.Err()
}
