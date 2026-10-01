package server

import (
	"context"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/dashboarddb"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type dashboardDatabaseFixture struct {
	dashboarddb.Database
}

func (dashboardDatabaseFixture) Open(context.Context) (dashboarddb.Snapshot, error) {
	return dashboardSnapshotFixture{}, nil
}

type dashboardSnapshotFixture struct {
	dashboarddb.Snapshot
}

func (dashboardSnapshotFixture) State() dashboarddb.State {
	return dashboarddb.State{Available: true, Revision: 42}
}

func (dashboardSnapshotFixture) LoadSource(_ context.Context, name string, _ *query.Definition) (model.Source, model.Metrics, error) {
	return model.Source{Source: name, Rows: []model.Row{{"id": "sample"}}}, model.Metrics{}, nil
}

func (dashboardDatabaseFixture) ExecuteQueries(definitions []query.Definition, requested []string, loader query.Loader) (map[string]model.Source, model.Metrics, error) {
	return query.New(loader).Execute(definitions, requested)
}

func TestQueryUsesConfiguredDashboardDatabase(t *testing.T) {
	db := dashboardDatabaseFixture{}
	app := &App{database: db, config: Config{DashboardQueries: []query.Definition{{Name: "selected", From: "runs"}}}}
	result, status, err := app.executeQuery(t.Context(), queryRequest{SourceNames: []string{"selected"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if status != 200 || result.Revision != 42 || result.Sources["selected"].Rows[0]["id"] != "sample" {
		t.Fatalf("query did not use configured dashboard database: status=%d result=%+v", status, result)
	}
}
