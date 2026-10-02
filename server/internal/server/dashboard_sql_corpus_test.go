package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestDashboardQueryCorpusUsesPostgres(t *testing.T) {
	store := integrationDatabase(t)
	definitions, err := dashboardSQLCorpus()
	if err != nil {
		t.Fatal(err)
	}
	if err := query.Validate(definitions); err != nil {
		t.Fatalf("validate deployed dashboard query corpus: %v", err)
	}
	runtimeSource := func(_ context.Context, name string) (model.Source, error) {
		return model.Source{
			Source: name,
			Rows:   []model.Row{},
			Metadata: model.Metadata{
				"availability": "empty",
				"completeness": "complete",
				"freshness":    "current",
			},
		}, nil
	}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.NativeReader) error {
		for _, definition := range definitions {
			sources, _, err := reader.ExecuteSQLPlanWithOptions(
				ctx, definitions, []string{definition.Name},
				postgresx.SQLExecutionOptions{Runtime: runtimeSource},
			)
			if err != nil {
				return fmt.Errorf("execute dashboard query %q through PostgreSQL: %w", definition.Name, err)
			}
			if _, ok := sources[definition.Name]; !ok {
				return fmt.Errorf("PostgreSQL SQL plan omitted dashboard query %q", definition.Name)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func dashboardSQLCorpus() ([]query.Definition, error) {
	dashboardPath := "../../../dashboard/site/dashboard.json"
	content, err := os.ReadFile(dashboardPath)
	if err != nil {
		return nil, fmt.Errorf("read deployed dashboard document: %w", err)
	}
	var dashboard struct {
		Fragments []string `json:"fragments"`
		Dashboard struct {
			Queries []query.Definition `json:"queries"`
		} `json:"dashboard"`
	}
	if err := json.Unmarshal(content, &dashboard); err != nil {
		return nil, fmt.Errorf("parse deployed dashboard document: %w", err)
	}
	definitions := append([]query.Definition{}, dashboard.Dashboard.Queries...)
	for _, fragment := range dashboard.Fragments {
		path := filepath.Join("../../../dashboard/site", fragment)
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read deployed dashboard fragment %q: %w", fragment, err)
		}
		var document struct {
			Queries []query.Definition `json:"queries"`
		}
		if err := json.Unmarshal(content, &document); err != nil {
			return nil, fmt.Errorf("parse deployed dashboard fragment %q: %w", fragment, err)
		}
		definitions = append(definitions, document.Queries...)
	}
	databaseQueries, err := ParseDashboardQueries("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		return nil, fmt.Errorf("read canonical database queries: %w", err)
	}
	definitions = append(definitions, databaseQueries...)
	if len(definitions) == 0 {
		return nil, fmt.Errorf("deployed dashboard query corpus is empty")
	}
	return definitions, nil
}
