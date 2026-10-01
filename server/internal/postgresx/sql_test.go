package postgresx

import (
	"reflect"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestPostgresSQLBindsValuesAndQuotesIdentifiers(t *testing.T) {
	input := `owner' OR TRUE -- <script>alert(1)</script>`
	name := `counts"; DROP TABLE cao_counts; --`
	statement, args, err := postgresSQL(
		`SELECT * FROM {} WHERE namespace = {} AND source_name = {}`,
		sqlIdentifier(name), input, "runs",
	)
	if err != nil {
		t.Fatal(err)
	}
	if want := `SELECT * FROM "counts""; DROP TABLE cao_counts; --" WHERE namespace = $1 AND source_name = $2`; statement != want {
		t.Fatalf("unexpected SQL: %q", statement)
	}
	if !reflect.DeepEqual(args, []any{input, "runs"}) {
		t.Fatalf("unexpected bind values: %#v", args)
	}
	if strings.Contains(statement, input) {
		t.Fatal("untrusted value was interpolated into SQL")
	}
}

func TestPostgresSQLRejectsInvalidIdentifiersAndArity(t *testing.T) {
	for _, name := range []sqlIdentifier{"", "bad\x00name"} {
		if _, _, err := postgresSQL(`SELECT * FROM {}`, name); err == nil {
			t.Fatalf("identifier %q was accepted", name)
		}
	}
	if _, _, err := postgresSQL(`SELECT {}`, 1, 2); err == nil {
		t.Fatal("extra parameters were accepted")
	}
	if _, _, err := postgresSQL(`SELECT {} AND {}`, 1); err == nil {
		t.Fatal("missing parameters were accepted")
	}
}

func TestNativeDocumentFilterUsesBoundValuesAndWhitelistedIdentifiers(t *testing.T) {
	namespace := `tenant' OR TRUE --`
	source := `$jobs' OR TRUE --`
	predicate := `run' OR TRUE --`
	where, args := documentFilter(namespace, source, &query.Filter{Predicates: []query.Predicate{
		{Field: "runId", Equals: predicate},
		{Field: "sessionId", Equals: "session-1"},
	}})
	statement, values, err := postgresSQL("SELECT count(*) FROM cao_source_documents WHERE "+where, args...)
	if err != nil {
		t.Fatal(err)
	}
	if want := `SELECT count(*) FROM cao_source_documents WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0 AND "run_id" = $3 AND "session_id" = $4`; statement != want {
		t.Fatalf("unexpected native filter SQL: %q", statement)
	}
	if !reflect.DeepEqual(values, []any{namespace, source, predicate, "session-1"}) {
		t.Fatalf("unexpected bound values: %#v", values)
	}
}
