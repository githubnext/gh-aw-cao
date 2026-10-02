package postgresx

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestDecodeJSONPreservesNumbers(t *testing.T) {
	var row map[string]any
	if err := decodeJSON([]byte(`{"id":9007199254740993}`), &row); err != nil {
		t.Fatal(err)
	}
	if row["id"] != json.Number("9007199254740993") {
		t.Fatalf("number lost precision: %#v", row)
	}
}

func TestNamespaceRequired(t *testing.T) {
	if _, err := NewWithNamespace(t.Context(), "postgres://127.0.0.1/postgres?sslmode=disable", ""); err == nil {
		t.Fatal("empty namespace accepted")
	}
}

func TestConnectionTransport(t *testing.T) {
	for _, test := range []struct {
		endpoint string
		valid    bool
	}{
		{"postgres://127.0.0.1/postgres?sslmode=disable", true},
		{"postgres://localhost/postgres?sslmode=disable", true},
		{"postgres://db.example.com/postgres?sslmode=disable", false},
		{"postgres://db.example.com/postgres?sslmode=require", true},
	} {
		config, err := pgx.ParseConfig(test.endpoint)
		if err != nil {
			t.Fatal(err)
		}
		if valid := validateTransport(config) == nil; valid != test.valid {
			t.Errorf("transport accepted=%t want=%t", valid, test.valid)
		}
	}
}

func TestRejectsInsecureDSNWithoutLeakingCredentials(t *testing.T) {
	_, err := New(context.Background(), "postgres://operator:secret@example.com/postgres?sslmode=disable")
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe transport failure: %v", err)
	}
}
