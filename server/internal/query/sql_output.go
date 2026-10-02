package query

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/sqlbuilder"
)

// OutputStatement returns typed values and presence flags for bounded wire
// serialization. It does not construct a JSON document for every source row.
func (plan SQLPlan) OutputStatement(name string, offset, limit int) (string, []any, []string, error) {
	relation, exists := plan.Outputs[name]
	if !exists || relation.SQL == "" {
		return "", nil, nil, errors.New("SQL output is not declared")
	}
	if offset < 0 || limit <= 0 || limit > MaxOutputRows {
		return "", nil, nil, errors.New("invalid SQL output page")
	}
	fields := sortedSQLFields(relation.Columns)
	projection := make([]string, 0, max(1, len(fields)*2))
	for index, field := range fields {
		column := relation.Columns[field]
		projection = append(projection, column.Expression+" AS "+SQLIdentifier(field),
			"("+column.Presence+") IS TRUE AS "+SQLIdentifier(fmt.Sprintf("__present_%d", index)))
	}
	if len(projection) == 0 {
		projection = append(projection, "TRUE AS __empty_projection")
	}
	scoped, scopedArgs, rewritten := plan.Scoped(strings.Join(projection, ","), relation.SQL, relation.Order)
	builder := sqlbuilder.New(scopedArgs...)
	builder.Write("{}\nSELECT {} FROM {} ORDER BY {} LIMIT {} OFFSET {}",
		sqlbuilder.Fragment(scoped), sqlbuilder.Fragment(rewritten[0]),
		sqlbuilder.Fragment(rewritten[1]), sqlbuilder.Fragment(rewritten[2]), limit, offset)
	statement, args, err := builder.Statement()
	return statement, args, fields, err
}

// StatisticsStatement performs cardinality and byte accounting in Postgres,
// without fetching or reconstructing collections in Go.
func (plan SQLPlan) StatisticsStatement() (string, []any, error) {
	seen := map[string]bool{}
	var branches []string
	builder := sqlbuilder.New(plan.Args...)
	for _, step := range plan.Steps {
		if seen[step.Relation] {
			continue
		}
		seen[step.Relation] = true
		bound := builder.Bind(step.Relation)
		branches = append(branches, fmt.Sprintf("SELECT %s::text AS relation, count(*) AS rows, coalesce(sum(pg_column_size(r)),0) AS bytes FROM %s AS r",
			bound, SQLIdentifier(step.Relation)))
	}
	// Every relation is counted here, so each is evaluated once rather than
	// inlined into each of its consumers.
	counted := strings.ReplaceAll(plan.CTEs, " AS NOT MATERIALIZED (", " AS MATERIALIZED (")
	builder.Write("{}\n{}", sqlbuilder.Fragment(counted), sqlbuilder.Fragment(strings.Join(branches, " UNION ALL ")))
	return builder.Statement()
}

var (
	sqlRelationName = regexp.MustCompile(`"q[0-9]+"`)
	sqlParameter    = regexp.MustCompile(`\$([0-9]+)`)
)

// Scoped returns only the CTEs that the compiler fragments transitively
// reference, so Postgres does not plan unrelated relations, together with the
// compact bound arguments they use. The returned fragments are renumbered to
// match and are not otherwise changed.
func (plan SQLPlan) Scoped(fragments ...string) (string, []any, []string) {
	if len(plan.CTEList) == 0 {
		return plan.CTEs, plan.Args, fragments
	}
	index := make(map[string]int, len(plan.CTEList))
	for position, text := range plan.CTEList {
		index[sqlRelationName.FindString(text)] = position
	}
	needed := make([]bool, len(plan.CTEList))
	var visit func(text string, own string)
	visit = func(text string, own string) {
		for _, name := range sqlRelationName.FindAllString(text, -1) {
			position, exists := index[name]
			if !exists || name == own || needed[position] {
				continue
			}
			needed[position] = true
			visit(plan.CTEList[position], name)
		}
	}
	for _, fragment := range fragments {
		visit(fragment, "")
	}
	included := make([]string, 0, len(plan.CTEList))
	for position, text := range plan.CTEList {
		if needed[position] {
			included = append(included, text)
		}
	}
	numbers := map[string]int{}
	var args []any
	renumber := func(text string) string {
		return sqlParameter.ReplaceAllStringFunc(text, func(match string) string {
			number, ok := numbers[match]
			if !ok {
				old, _ := strconv.Atoi(match[1:])
				args = append(args, plan.Args[old-1])
				number = len(args)
				numbers[match] = number
			}
			return "$" + strconv.Itoa(number)
		})
	}
	statements := make([]string, len(included))
	for position, text := range included {
		statements[position] = renumber(text)
	}
	rewritten := make([]string, len(fragments))
	for position, fragment := range fragments {
		rewritten[position] = renumber(fragment)
	}
	if len(statements) == 0 {
		return "", args, rewritten
	}
	return "WITH " + strings.Join(statements, ",\n"), args, rewritten
}
