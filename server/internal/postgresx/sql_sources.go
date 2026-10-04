package postgresx

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

var recordSources = []string{"$domains", "$skills", "$friction", "$audits", "$issues"}

func sqlKind(column entityColumn) query.SQLKind {
	switch column.kind {
	case "numeric":
		return query.SQLNumber
	case "boolean":
		return query.SQLBoolean
	case "timestamp":
		return query.SQLTimestamp
	case "object":
		return query.SQLStructured
	default:
		return query.SQLText
	}
}

func relationColumns(table entityTable, presence func(int) string) map[string]query.SQLColumn {
	columns := make(map[string]query.SQLColumn, len(table.columns))
	for index, column := range table.columns {
		if strings.Contains(column.field, ".") {
			continue
		}
		expression := "t." + query.SQLIdentifier(column.name)
		kind := sqlKind(column)
		if column.kind == "object" {
			var parts []string
			for memberIndex, member := range table.columns {
				prefix := column.field + "."
				if !strings.HasPrefix(member.field, prefix) {
					continue
				}
				field := strings.TrimPrefix(member.field, prefix)
				parts = append(parts, "CASE WHEN "+presence(memberIndex)+" THEN jsonb_build_object('"+
					strings.ReplaceAll(field, "'", "''")+"', t."+query.SQLIdentifier(member.name)+") ELSE '{}'::jsonb END")
			}
			expression = "CASE WHEN " + expression + " IS TRUE THEN (" + strings.Join(parts, " || ") + ") ELSE NULL::jsonb END"
		}
		columns[column.field] = query.SQLColumn{Expression: expression, Presence: presence(index), Kind: kind}
	}
	return columns
}

func (r *readTransaction) entitySQLSource(name string) (query.SQLRelation, error) {
	if name == "$records" {
		return r.recordSQLSource()
	}
	table, exists := entityTables[name]
	if !exists || table.runtime {
		return query.SQLRelation{}, fmt.Errorf("SQL source %q is not registered by TypeSpec", name)
	}
	columns := relationColumns(table, func(index int) string { return "get_bit(t.present_fields, " + strconv.Itoa(index) + ") = 1" })
	for _, recordSource := range recordSources {
		if recordSource != name {
			continue
		}
		for _, family := range recordSources {
			familyColumns := relationColumns(entityTables[family], func(int) string { return "FALSE" })
			for field, column := range familyColumns {
				if _, exists := columns[field]; !exists {
					column.Expression = "NULL::" + wireSQLType(column.Kind)
					column.Presence = "FALSE"
					columns[field] = column
				}
			}
		}
	}
	return query.SQLRelation{
		SQL:     "(SELECT * FROM " + query.SQLIdentifier(table.name) + " WHERE namespace = {}) AS t",
		Params:  []any{r.store.namespace},
		Columns: columns,
		Order:   "t.ordinal",
	}, nil
}

func (r *readTransaction) recordSQLSource() (query.SQLRelation, error) {
	columns := map[string]query.SQLColumn{}
	relations := make([]query.SQLRelation, len(recordSources))
	for index, name := range recordSources {
		relation, err := r.entitySQLSource(name)
		if err != nil {
			return query.SQLRelation{}, err
		}
		relations[index] = relation
		for field, column := range relation.Columns {
			if existing, ok := columns[field]; ok && existing.Kind != column.Kind {
				return query.SQLRelation{}, fmt.Errorf("record union field %s has conflicting native types", field)
			}
			columns[field] = column
		}
	}
	fields := make([]string, 0, len(columns))
	for field := range columns {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	var branches []string
	var args []any
	for index, relation := range relations {
		projection := []string{strconv.Itoa(index) + "::integer AS __family", "t.ordinal"}
		for fieldIndex, field := range fields {
			value, present := "NULL::"+wireSQLType(columns[field].Kind), "FALSE"
			if column, ok := relation.Columns[field]; ok {
				value, present = column.Expression, column.Presence
			}
			projection = append(projection, value+" AS "+query.SQLIdentifier(field),
				present+" AS "+query.SQLIdentifier(fmt.Sprintf("__p_%d", fieldIndex)))
		}
		branches = append(branches, "SELECT "+strings.Join(projection, ",")+" FROM "+relation.SQL)
		args = append(args, relation.Params...)
	}
	for index, field := range fields {
		column := columns[field]
		column.Expression = "t." + query.SQLIdentifier(field)
		column.Presence = "t." + query.SQLIdentifier(fmt.Sprintf("__p_%d", index))
		columns[field] = column
	}
	return query.SQLRelation{SQL: "(" + strings.Join(branches, " UNION ALL ") + ") AS t", Params: args, Columns: columns, Order: "t.__family, t.ordinal"}, nil
}

func wireSQLType(kind query.SQLKind) string {
	switch kind {
	case query.SQLNumber:
		return "numeric"
	case query.SQLBoolean:
		return "boolean"
	case query.SQLTimestamp:
		return "timestamptz"
	case query.SQLStructured:
		return "jsonb"
	default:
		return "text"
	}
}

func runtimeSQLSource(name string, source model.Source) (query.SQLRelation, error) {
	table, exists := entityTables[name]
	if !exists || !table.runtime {
		return query.SQLRelation{}, errors.New("runtime SQL source is not explicitly registered")
	}
	if len(source.Rows) > query.MaxInputRows {
		return query.SQLRelation{}, fmt.Errorf("query %q exceeds max input rows", name)
	}
	if query.EstimateRowsBytes(source.Rows) > query.MaxWorkingBytes {
		return query.SQLRelation{}, fmt.Errorf("query %q exceeds max working bytes", name)
	}
	aliases := []string{}
	for index, column := range table.columns {
		aliases = append(aliases, query.SQLIdentifier(column.name), query.SQLIdentifier(fmt.Sprintf("__p_%d", index)))
	}
	columns := relationColumns(table, func(index int) string { return "t." + query.SQLIdentifier(fmt.Sprintf("__p_%d", index)) })
	workingBytes := query.EstimateRowsBytes(source.Rows) + int64(len(source.Rows))*int64(len(table.columns))*32
	if workingBytes > query.MaxWorkingBytes {
		return query.SQLRelation{}, fmt.Errorf("query %q exceeds max working bytes", name)
	}
	var parameters []string
	args := make([]any, 0, len(table.columns)*2)
	for _, column := range table.columns {
		values := make([]any, len(source.Rows))
		presence := make([]bool, len(source.Rows))
		for index, row := range source.Rows {
			value, present := entityFieldValue(row, column.field)
			bound, err := column.bind(value)
			if err != nil {
				return query.SQLRelation{}, fmt.Errorf("runtime %s.%s: %w", name, column.field, err)
			}
			values[index], presence[index] = bound, present
		}
		args = append(args, values, presence)
		parameters = append(parameters, "{}::"+column.sql+"[]", "{}::boolean[]")
	}
	aliases = append(aliases, "ordinal")
	relation := "unnest(" + strings.Join(parameters, ",") + ") WITH ORDINALITY AS t(" + strings.Join(aliases, ",") + ")"
	return query.SQLRelation{SQL: relation, Params: args, Columns: columns, Order: "t.ordinal"}, nil
}

func collectionDefinitions(definitions []query.Definition) []query.Definition {
	result := append([]query.Definition{}, definitions...)
	names := map[string]bool{}
	var runRecords *query.Definition
	for index := range definitions {
		names[definitions[index].Name] = true
		if definitions[index].Name == "run-records" {
			runRecords = &definitions[index]
		}
	}
	for _, source := range recordSources {
		name := strings.TrimPrefix(source, "$")
		if !names[name] && runRecords != nil {
			definition := *runRecords
			definition.Name, definition.From = name, source
			result = append(result, definition)
		}
	}
	return result
}
