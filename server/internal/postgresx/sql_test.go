package postgresx

import (
	"reflect"
	"strings"
	"testing"
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
