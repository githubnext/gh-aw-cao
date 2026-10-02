package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// These are physical, schema-owned composite types, not an EAV representation.
// JSON is retained only for provider extensions and arbitrary semantic values.
type nestedField struct {
	key, kind string
	object    *nestedType
}

type nestedType struct {
	name   string
	open   bool
	fields []nestedField
}

var campaignWorkerType = &nestedType{"cao_campaign_worker", false, []nestedField{
	{"id", "text", nil}, {"workflow", "text", nil},
	{"enabled", "boolean", nil}, {"max-mode", "text", nil},
}}

var campaignTargetType = &nestedType{"cao_campaign_target", false, []nestedField{
	{"repository", "text", nil}, {"mode", "text", nil},
}}

var intelligenceFieldsType = &nestedType{"cao_intelligence_fields", false, []nestedField{
	{"repositoryNativeProblem", "json", nil}, {"eligibleOpportunity", "json", nil},
	{"intendedOutcome", "json", nil}, {"outcomeAttainmentEvidence", "json", nil},
	{"targetPopulation", "json", nil}, {"interventionClass", "json", nil},
	{"triggerAndSchedule", "json", nil}, {"scheduleRationale", "json", nil},
	{"maxDetectionDelay", "json", nil}, {"resourceEnvelope", "json", nil},
	{"overlapIdentity", "json", nil}, {"outputApprovalPolicy", "json", nil},
	{"maturationPeriod", "json", nil}, {"deduplication", "json", nil},
	{"backoff", "json", nil}, {"stopConditions", "json", nil},
	{"operationalValueDefinition", "json", nil},
}}

var intelligenceType = &nestedType{"cao_intelligence_declaration", false, []nestedField{
	{"contractVersion", "text", nil}, {"campaign", "text", nil},
	{"fields", "object", intelligenceFieldsType},
}}

var modelUsageType = &nestedType{"cao_model_usage", true, []nestedField{
	{"total_aic", "numeric", nil}, {"total_input_tokens", "numeric", nil},
	{"total_output_tokens", "numeric", nil}, {"total_cache_read_tokens", "numeric", nil},
	{"total_cache_write_tokens", "numeric", nil}, {"total_requests", "numeric", nil},
	{"cache_efficiency", "numeric", nil}, {"input_tokens", "numeric", nil},
	{"output_tokens", "numeric", nil}, {"cache_read_tokens", "numeric", nil},
	{"cache_write_tokens", "numeric", nil}, {"reasoning_tokens", "numeric", nil},
	{"requests", "numeric", nil}, {"aic", "numeric", nil},
}}

var tokenUsageType = &nestedType{"cao_token_usage", true, append(
	append([]nestedField{}, modelUsageType.fields...), nestedField{"by_model", "dictionary", modelUsageType})}

var sourceProvenanceType = &nestedType{"cao_source_provenance", true, []nestedField{
	{"kind", "text", nil}, {"sourceId", "text", nil},
	{"sourceSchemaRevision", "numeric", nil}, {"repository", "text", nil},
	{"runId", "text", nil}, {"runAttempt", "numeric", nil},
	{"actor", "text", nil}, {"observedAt", "timestamp", nil},
	{"generation", "text", nil}, {"completeness", "text", nil},
	{"freshness", "text", nil}, {"evidenceLinks", "text-array", nil},
}}

var nativeNestedFields = map[string]nestedField{
	"workers":                 {"workers", "array", campaignWorkerType},
	"targets":                 {"targets", "array", campaignTargetType},
	"intelligenceDeclaration": {"intelligenceDeclaration", "object", intelligenceType},
	"tokenUsage":              {"tokenUsage", "object", tokenUsageType},
	"sourceProvenance":        {"sourceProvenance", "object", sourceProvenanceType},
}

func nestedColumn(key string) string {
	var column strings.Builder
	for i, character := range key {
		switch {
		case character >= 'A' && character <= 'Z':
			if i > 0 {
				column.WriteByte('_')
			}
			column.WriteRune(character + 'a' - 'A')
		case character == '-':
			column.WriteByte('_')
		default:
			column.WriteRune(character)
		}
	}
	return column.String()
}

func (f nestedField) sqlType() string {
	switch f.kind {
	case "object":
		return f.object.name
	case "array":
		return f.object.name + "[]"
	case "dictionary":
		return f.object.name + "_entry[]"
	case "timestamp":
		return "timestamptz"
	case "text-array":
		return "text[]"
	default:
		return f.kind
	}
}

func (f nestedField) validate(value any) error {
	if value == nil {
		return nil
	}
	switch f.kind {
	case "json":
		return nil
	case "text":
		if _, ok := value.(string); ok {
			return nil
		}
	case "boolean":
		if _, ok := value.(bool); ok {
			return nil
		}
	case "numeric":
		if _, ok := value.(json.Number); ok {
			return nil
		}
	case "timestamp":
		if text, ok := value.(string); ok {
			if _, err := time.Parse(time.RFC3339Nano, text); err == nil {
				return nil
			}
		}
	case "text-array":
		if items, ok := value.([]any); ok {
			for _, item := range items {
				if _, ok := item.(string); !ok {
					return fmt.Errorf("%s contains a non-string", f.key)
				}
			}
			return nil
		}
	case "object":
		return f.object.validate(value)
	case "array":
		if items, ok := value.([]any); ok {
			for i, item := range items {
				if err := f.object.validate(item); err != nil {
					return fmt.Errorf("%s[%d]: %w", f.key, i, err)
				}
			}
			return nil
		}
	case "dictionary":
		if items, ok := value.(map[string]any); ok {
			for key, item := range items {
				if err := f.object.validate(item); err != nil {
					return fmt.Errorf("%s[%q]: %w", f.key, key, err)
				}
			}
			return nil
		}
	}
	return fmt.Errorf("%s has unsupported native %s shape", f.key, f.kind)
}

func (t *nestedType) validate(value any) error {
	if value == nil {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%s must be an object", t.name)
	}
	for key, value := range object {
		known := false
		for _, field := range t.fields {
			if key == field.key {
				known = true
				if err := field.validate(value); err != nil {
					return err
				}
				break
			}
		}
		if !known && !t.open {
			return fmt.Errorf("%s has unknown property %q", t.name, key)
		}
	}
	return nil
}

// All SQL identifiers and literals below come from the static catalogues.
func nestedLiteral(key string) string { return "'" + strings.ReplaceAll(key, "'", "''") + "'" }

func (t *nestedType) writeSQL(input string, depth int) string {
	alias := fmt.Sprintf("nw%d", depth)
	values := []string{"ARRAY(SELECT json_object_keys(" + alias + ".v))"}
	for _, field := range t.fields {
		part := alias + ".v -> " + nestedLiteral(field.key)
		switch field.kind {
		case "numeric":
			text := "(" + part + " #>> '{}')"
			// Bound precision/exponent before casting; exceptional lexemes stay
			// in the paired TEXT column instead of overflowing NUMERIC.
			native := "(CASE WHEN length(" + text + ") <= 1000 AND " + text +
				" !~ '[eE][+-]?[0-9]{4,}' THEN (" + text + ")::numeric END)"
			values = append(values, native, "CASE WHEN "+text+" IS DISTINCT FROM "+native+"::text THEN "+text+" END")
		case "timestamp":
			text := "(" + part + " #>> '{}')"
			native := "(" + text + "::timestamptz)"
			values = append(values, native, "CASE WHEN "+text+" IS DISTINCT FROM ("+
				timestampNativeReadExpression(native)+") THEN "+text+" END")
		default:
			values = append(values, field.writeSQL(part, depth+1))
		}
	}
	if t.open {
		keys := make([]string, 0, len(t.fields))
		for _, field := range t.fields {
			keys = append(keys, nestedLiteral(field.key))
		}
		values = append(values, "(SELECT json_object_agg(key, value) FROM json_each("+alias+
			".v) WHERE key NOT IN ("+strings.Join(keys, ",")+"))")
	}
	return "(SELECT CASE WHEN " + alias + ".v IS NULL OR json_typeof(" + alias + ".v) = 'null' THEN NULL ELSE ROW(" +
		strings.Join(values, ",") + ")::" + t.name + " END FROM (SELECT " + input + " AS v) " + alias + ")"
}

func (f nestedField) writeSQL(input string, depth int) string {
	switch f.kind {
	case "object":
		return f.object.writeSQL(input, depth)
	case "array":
		alias := fmt.Sprintf("na%d", depth)
		return "(CASE WHEN " + input + " IS NULL OR json_typeof(" + input + ") = 'null' THEN NULL ELSE " +
			"ARRAY(SELECT " + f.object.writeSQL(alias+".value", depth+1) +
			" FROM json_array_elements(" + input + ") WITH ORDINALITY " + alias + "(value, position) ORDER BY position) END)"
	case "dictionary":
		alias := fmt.Sprintf("nd%d", depth)
		return "(CASE WHEN " + input + " IS NULL OR json_typeof(" + input + ") = 'null' THEN NULL ELSE " +
			"ARRAY(SELECT ROW(key, " + f.object.writeSQL(alias+".value", depth+1) + ")::" + f.object.name +
			"_entry FROM json_each(" + input + ") " + alias + " ORDER BY key) END)"
	case "json":
		return input
	case "text-array":
		return "(CASE WHEN " + input + " IS NULL OR json_typeof(" + input +
			") = 'null' THEN NULL ELSE ARRAY(SELECT json_array_elements_text(" + input + ")) END)"
	default:
		return "(" + input + " #>> '{}')::" + f.kind
	}
}

func (t *nestedType) readSQL(input string, depth int) string {
	alias := fmt.Sprintf("nr%d", depth)
	parts := make([]string, 0, len(t.fields))
	for _, field := range t.fields {
		value := "(" + alias + ".v)." + nestedColumn(field.key)
		var encoded string
		switch field.kind {
		case "numeric":
			encoded = "COALESCE((" + alias + ".v)." + nestedColumn(field.key) + "_raw, " + value + "::text)::json"
		case "timestamp":
			encoded = "to_json(" + timestampReadExpression(value) + ")"
		default:
			encoded = field.readSQL(value, depth+1)
		}
		parts = append(parts, "SELECT "+nestedLiteral(field.key)+" AS key, COALESCE("+encoded+", 'null'::json) AS value "+
			"WHERE "+nestedLiteral(field.key)+" = ANY(("+alias+".v).present)")
	}
	if t.open {
		parts = append(parts, "SELECT key, value FROM json_each(("+alias+".v).extension)")
	}
	return "(SELECT CASE WHEN (" + alias + ".v).present IS NULL THEN 'null'::json ELSE " +
		"(SELECT COALESCE(json_object_agg(key, value), '{}'::json) FROM (" +
		strings.Join(parts, " UNION ALL ") + ") parts) END FROM (SELECT " + input + " AS v) " + alias + ")"
}

func (f nestedField) readSQL(input string, depth int) string {
	switch f.kind {
	case "object":
		return f.object.readSQL(input, depth)
	case "array":
		alias := fmt.Sprintf("ar%d", depth)
		return "(CASE WHEN " + input + " IS NULL THEN 'null'::json ELSE (SELECT COALESCE(json_agg(" +
			f.object.readSQL("("+input+")["+alias+".position]", depth+1) +
			" ORDER BY position), '[]'::json) FROM generate_subscripts(" +
			input + ", 1) " + alias + "(position)) END)"
	case "dictionary":
		alias := fmt.Sprintf("dr%d", depth)
		return "(CASE WHEN " + input + " IS NULL THEN 'null'::json ELSE (SELECT COALESCE(json_object_agg(" +
			alias + ".name, " + f.object.readSQL(alias+".usage", depth+1) + "), '{}'::json) FROM unnest(" +
			input + ") " + alias + "(name, usage)) END)"
	case "json":
		return input
	default:
		return "to_json(" + input + ")"
	}
}

func nestedReadExpression(key, column string) string {
	if field, ok := nativeNestedFields[key]; ok {
		return "(" + field.readSQL(column, 0) + ")::text"
	}
	return column + "::text"
}

func nestedTypeColumns(t *nestedType) []storageColumn {
	columns := []storageColumn{{"present", "text[]", ""}}
	for _, field := range t.fields {
		columns = append(columns, storageColumn{nestedColumn(field.key), field.sqlType(), ""})
		if field.kind == "numeric" || field.kind == "timestamp" {
			columns = append(columns, storageColumn{nestedColumn(field.key) + "_raw", "text", ""})
		}
	}
	if t.open {
		columns = append(columns, storageColumn{"extension", "json", ""})
	}
	return columns
}

func initializeNestedTypes(ctx context.Context, tx *sql.Tx) error {
	for _, t := range []*nestedType{campaignWorkerType, campaignTargetType, intelligenceFieldsType,
		intelligenceType, modelUsageType, tokenUsageType, sourceProvenanceType} {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_type
			WHERE typnamespace = current_schema()::regnamespace AND typname = $1)`, t.name).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			var columns []string
			for _, column := range nestedTypeColumns(t) {
				columns = append(columns, column.name+" "+column.kind)
			}
			if _, err := tx.ExecContext(ctx, "CREATE TYPE "+t.name+" AS ("+strings.Join(columns, ",")+")"); err != nil {
				return err
			}
		} else {
			if err := verifyStorageTable(ctx, tx, storageTable{name: t.name, columns: nestedTypeColumns(t)}); err != nil {
				return err
			}
		}
		if t == modelUsageType {
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_type
				WHERE typnamespace = current_schema()::regnamespace AND typname = $1)`, t.name+"_entry").Scan(&exists); err != nil {
				return err
			}
			if !exists {
				if _, err := tx.ExecContext(ctx, "CREATE TYPE "+t.name+"_entry AS (name text, usage "+t.name+")"); err != nil {
					return err
				}
			} else if err := verifyStorageTable(ctx, tx, storageTable{name: t.name + "_entry",
				columns: []storageColumn{{"name", "text", ""}, {"usage", t.name, ""}}}); err != nil {
				return err
			}
		}
	}
	return nil
}
