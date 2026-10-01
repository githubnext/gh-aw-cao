package dashboarddb

import (
	"errors"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type testLoader struct {
	source model.Source
}

func (loader testLoader) LoadSource(string, *query.Definition) (model.Source, model.Metrics, error) {
	return loader.source, model.Metrics{}, nil
}

func TestRedisQueryValidationAndExecution(t *testing.T) {
	db := NewRedis(nil)
	if err := db.ValidateQueries([]query.Definition{{Name: "invalid"}}); err == nil {
		t.Fatal("invalid query was accepted")
	}
	if _, _, err := db.ExecuteQueries([]query.Definition{{Name: "invalid"}}, []string{"invalid"}, testLoader{}); err == nil {
		t.Fatal("invalid query was executed")
	}

	definitions := []query.Definition{{Name: "selected", From: "runs"}}
	rows := []model.Row{{"id": "run-1"}}
	sources, _, err := db.ExecuteQueries(definitions, []string{"selected"}, testLoader{
		source: model.Source{Source: "runs", Rows: rows},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sources["selected"].Rows) != 1 || sources["selected"].Rows[0]["id"] != "run-1" {
		t.Fatalf("unexpected query result: %v", sources)
	}
}

func TestRedisQueryLoaderFailure(t *testing.T) {
	db := NewRedis(nil)
	_, _, err := db.ExecuteQueries(nil, []string{"runs"}, failingLoader{})
	if err == nil {
		t.Fatal("loader failure was ignored")
	}
}

func TestRedisReplacementRequiresDataRevision(t *testing.T) {
	db := NewRedis(nil)
	if _, err := db.Replace(t.Context(), Projection{}); err == nil {
		t.Fatal("missing revision must fail before accessing storage")
	}
}

type failingLoader struct{}

func (failingLoader) LoadSource(string, *query.Definition) (model.Source, model.Metrics, error) {
	return model.Source{}, model.Metrics{}, errors.New("source unavailable")
}
