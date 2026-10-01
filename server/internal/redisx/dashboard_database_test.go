package redisx

import (
	"context"
	"errors"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/dashboarddb"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type noCommands struct{}

func (noCommands) Do(context.Context, ...string) (any, error) {
	return nil, errors.New("unexpected Redis command")
}

func (noCommands) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, errors.New("unexpected Redis commands")
}

type activeOnce struct{ reads int }

func (client *activeOnce) Do(_ context.Context, args ...string) (any, error) {
	if args[0] != "HGETALL" || client.reads != 0 {
		return nil, errors.New("snapshot was read again")
	}
	client.reads++
	return []any{
		"generation", "pinned", "revision", "1", "counts", "{}",
		"activatedAt", "2026-01-01T00:00:00Z",
	}, nil
}

func (*activeOnce) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, errors.New("unexpected Redis commands")
}

func TestDashboardReaderPinsSnapshotForQuery(t *testing.T) {
	client := &activeOnce{}
	db := &DashboardDatabase{Store: NewStore(client, "dashboard-test")}
	reader, err := db.Current(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	runtime := func(name string, _ *query.Definition) (model.Source, model.Metrics, bool, error) {
		return model.Source{Source: name, Rows: []model.Row{{"id": "1"}}}, model.Metrics{}, true, nil
	}
	sources, _, err := reader.Execute(t.Context(), nil, []string{"runtime"}, runtime)
	if err != nil || client.reads != 1 || len(sources["runtime"].Rows) != 1 || reader.State().Revision != 1 {
		t.Fatalf("reader did not pin snapshot: sources=%v reads=%d err=%v", sources, client.reads, err)
	}
}

func TestDashboardDatabaseRejectsInvalidRevisionBeforeWriting(t *testing.T) {
	db := &DashboardDatabase{Store: NewStore(noCommands{}, "dashboard-test")}
	if _, err := db.Ingest(t.Context(), dashboarddb.Transactions{DataRevision: "short"}); err == nil {
		t.Fatal("invalid revision should fail without staging a generation")
	}
}

func TestDashboardDatabaseValidatesQueries(t *testing.T) {
	db := &DashboardDatabase{}
	if err := db.Validate([]query.Definition{{Name: "q", From: "runs"}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Validate([]query.Definition{{Name: "q"}}); err == nil {
		t.Fatal("query without a source must be rejected")
	}
}

func TestDashboardLoaderPreservesUnavailableSource(t *testing.T) {
	// Runtime sources must not accidentally fall through to dashboard storage.
	loader := &dashboardLoader{
		runtime: func(name string, _ *query.Definition) (model.Source, model.Metrics, bool, error) {
			return model.Source{Source: name}, model.Metrics{}, true, nil
		},
	}
	source, _, err := loader.LoadSource("runtime", nil)
	if err != nil || source.Source != "runtime" {
		t.Fatalf("runtime source was not resolved: source=%+v err=%v", source, err)
	}
}
