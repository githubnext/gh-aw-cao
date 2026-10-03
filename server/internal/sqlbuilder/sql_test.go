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

func TestValidateIdentifierRejectsEmptyNulAndInvalidUTF8(t *testing.T) {
	for _, name := range []string{"", "bad\x00name", string([]byte{0xff})} {
		if err := validateIdentifier(name); err == nil {
			t.Fatalf("validateIdentifier(%q) = nil, want error", name)
		}
	}
	if err := validateIdentifier("valid_name"); err != nil {
		t.Fatalf("validateIdentifier(valid) = %v, want nil", err)
	}
}

func TestValidateFragmentRejectsEmbeddedNul(t *testing.T) {
	if err := validateFragment("bad\x00fragment"); err == nil {
		t.Fatal("validateFragment with embedded NUL = nil, want error")
	}
	if err := validateFragment("SELECT 1"); err != nil {
		t.Fatalf("validateFragment(valid) = %v, want nil", err)
	}
}

func TestBuilderTracksRejectionStage(t *testing.T) {
	cases := []struct {
		name  string
		write func(b *Builder)
		stage rejectionStage
	}{
		{
			name:  "placeholder count mismatch",
			write: func(b *Builder) { b.Write("SELECT {}", 1, 2) },
			stage: rejectionStagePlaceholderCount,
		},
		{
			name:  "invalid identifier",
			write: func(b *Builder) { b.Write("SELECT * FROM {}", Identifier("")) },
			stage: rejectionStageIdentifier,
		},
		{
			name:  "invalid fragment",
			write: func(b *Builder) { b.Write("{}", Fragment("bad\x00fragment")) },
			stage: rejectionStageFragment,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			builder := New()
			testCase.write(builder)
			if builder.stage != testCase.stage {
				t.Fatalf("stage = %q, want %q", builder.stage, testCase.stage)
			}
			if _, _, err := builder.Statement(); err == nil {
				t.Fatal("Statement() = nil error, want rejection")
			}
		})
	}
}

func TestBuilderStageStaysNoneOnSuccess(t *testing.T) {
	builder := New()
	builder.Write("SELECT {} FROM {}", "value", Identifier("rows"))
	if builder.stage != rejectionStageNone {
		t.Fatalf("stage = %q, want %q", builder.stage, rejectionStageNone)
	}
	if _, _, err := builder.Statement(); err != nil {
		t.Fatalf("Statement() = %v, want nil", err)
	}
}
