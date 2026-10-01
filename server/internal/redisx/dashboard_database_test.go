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

func TestDashboardDatabaseRejectsInvalidRevisionBeforeWriting(t *testing.T) {
	db := &DashboardDatabase{Store: NewStore(noCommands{}, "dashboard-test")}
	if _, err := db.Replace(t.Context(), dashboarddb.Snapshot{DataRevision: "short"}); err == nil {
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
