package ingest

import (
	"context"
	"errors"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/dashboarddb"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type recordingDatabase struct {
	state        dashboarddb.State
	transactions dashboarddb.Transactions
	writes       int
}

func (db *recordingDatabase) Current(context.Context) (dashboarddb.Reader, error) {
	return recordingReader{state: db.state}, nil
}

func (db *recordingDatabase) Validate(definitions []query.Definition) error {
	return query.Validate(definitions)
}

func (db *recordingDatabase) Ingest(_ context.Context, transactions dashboarddb.Transactions) (dashboarddb.State, error) {
	db.transactions = transactions
	db.writes++
	db.state = dashboarddb.State{
		Revision: int64(db.writes), DataRevision: transactions.DataRevision,
		EvaluatedAt: transactions.EvaluatedAt, Counts: map[string]int{}, Available: true,
	}
	for name, source := range transactions.Sources {
		db.state.Counts[name] = len(source.Rows)
	}
	return db.state, nil
}

type recordingReader struct{ state dashboarddb.State }

func (reader recordingReader) State() dashboarddb.State { return reader.state }

func (recordingReader) Execute(context.Context, []query.Definition, []string, dashboarddb.RuntimeSource) (map[string]model.Source, model.Metrics, error) {
	return nil, model.Metrics{}, errors.New("not used")
}

func TestRunDatabasePublishesAndReusesCallTables(t *testing.T) {
	db := &recordingDatabase{}
	options := Options{DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json"}
	for attempt := 0; attempt < 2; attempt++ {
		result, err := RunDatabase(t.Context(), db, "../../testdata/deployed-subset", options)
		if err != nil {
			t.Fatal(err)
		}
		if result.Revision != 1 || result.DataRevision == "" || db.writes != 1 {
			t.Fatalf("unexpected publication state: result=%+v writes=%d", result, db.writes)
		}
		if len(db.transactions.Sources["runs"].Rows) == 0 || len(db.transactions.Sources["tools"].Rows) == 0 {
			t.Fatal("canonical call tables were not published")
		}
		if db.transactions.Diagnostics.SchemaVersion != model.SchemaVersion {
			t.Fatal("diagnostics were not published with the snapshot")
		}
		if len(db.transactions.RepositoryMemory) == 0 {
			t.Fatal("repository memory was not published with the snapshot")
		}
	}
}
