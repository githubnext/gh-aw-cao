package sqlbuilder

import (
	"reflect"
	"strings"
	"testing"
)

func TestValuesAreBoundAndIdentifiersQuoted(t *testing.T) {
	name := `rows"; DROP TABLE rows; --`
	input := `x' OR TRUE --`
	statement, args, err := Build("SELECT * FROM {} WHERE namespace = {} AND id = {}", Identifier(name), input, "record")
	if err != nil {
		t.Fatal(err)
	}
	if statement != `SELECT * FROM "rows""; DROP TABLE rows; --" WHERE namespace = $1 AND id = $2` ||
		!reflect.DeepEqual(args, []any{input, "record"}) || strings.Contains(statement, input) {
		t.Fatalf("unsafe SQL construction: %q %#v", statement, args)
	}
}

func TestCompilerFragmentsDoNotTurnStringsIntoSQL(t *testing.T) {
	builder := New("existing")
	builder.Write("{} SELECT {} FROM {} LIMIT {}", Fragment("WITH q AS (SELECT $1::text AS value)"), Identifier("value"), Identifier("q"), 10)
	statement, args, err := builder.Statement()
	if err != nil || statement != `WITH q AS (SELECT $1::text AS value) SELECT "value" FROM "q" LIMIT $2` ||
		!reflect.DeepEqual(args, []any{"existing", 10}) {
		t.Fatalf("fragment/parameter numbering failed: %q %#v %v", statement, args, err)
	}
}

func TestBuilderRejectsInvalidStructure(t *testing.T) {
	for _, name := range []Identifier{"", "bad\x00name", Identifier(string([]byte{0xff}))} {
		if _, _, err := Build("SELECT * FROM {}", name); err == nil {
			t.Fatal("invalid identifier admitted")
		}
	}
	if _, _, err := Build("SELECT {}", 1, 2); err == nil {
		t.Fatal("placeholder arity mismatch admitted")
	}
}
