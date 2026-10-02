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
	definitions, parameters, err := dashboardSQLCorpus()
	if err != nil {
		t.Fatal(err)
	}
	if err := bindDashboardSQLCorpusInputs(definitions, parameters); err != nil {
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
			sources, metrics, err := reader.ExecuteSQLPlanWithOptions(
				ctx, definitions, []string{definition.Name},
				postgresx.SQLExecutionOptions{Runtime: runtimeSource},
			)
			if err != nil {
				return fmt.Errorf("execute dashboard query %q through PostgreSQL: %w", definition.Name, err)
			}
			if _, ok := sources[definition.Name]; !ok {
				return fmt.Errorf("PostgreSQL SQL plan omitted dashboard query %q", definition.Name)
			}
			if len(metrics.FallbackOperations) != 0 {
				return fmt.Errorf("dashboard query %q used Go fallback operations: %v",
					definition.Name, metrics.FallbackOperations)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func dashboardSQLCorpus() ([]query.Definition, map[string]any, error) {
	dashboardPath := "../../../dashboard/site/dashboard.json"
	content, err := os.ReadFile(dashboardPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read deployed dashboard document: %w", err)
	}
	var dashboard struct {
		Fragments []string `json:"fragments"`
		Dashboard struct {
			Queries []query.Definition `json:"queries"`
		} `json:"dashboard"`
	}
	if err := json.Unmarshal(content, &dashboard); err != nil {
		return nil, nil, fmt.Errorf("parse deployed dashboard document: %w", err)
	}
	definitions := append([]query.Definition{}, dashboard.Dashboard.Queries...)
	parameters := map[string]any{}
	for _, fragment := range dashboard.Fragments {
		path := filepath.Join("../../../dashboard/site", fragment)
		content, err := os.ReadFile(path) // #nosec G304 -- fragments come from the checked-in dashboard manifest in this repository test.
		if err != nil {
			return nil, nil, fmt.Errorf("read deployed dashboard fragment %q: %w", fragment, err)
		}
		var document struct {
			Queries []query.Definition `json:"queries"`
			Pages   []struct {
				Form struct {
					Fields []struct {
						ID      string `json:"id"`
						Default any    `json:"default"`
					} `json:"fields"`
				} `json:"form"`
			} `json:"pages"`
		}
		if err := json.Unmarshal(content, &document); err != nil {
			return nil, nil, fmt.Errorf("parse deployed dashboard fragment %q: %w", fragment, err)
		}
		definitions = append(definitions, document.Queries...)
		for _, page := range document.Pages {
			for _, field := range page.Form.Fields {
				if field.ID != "" && field.Default != nil {
					parameters[field.ID] = field.Default
				}
			}
		}
	}
	databaseQueries, err := ParseDashboardQueries("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		return nil, nil, fmt.Errorf("read canonical database queries: %w", err)
	}
	definitions = append(definitions, databaseQueries...)
	if len(definitions) == 0 {
		return nil, nil, fmt.Errorf("deployed dashboard query corpus is empty")
	}
	return definitions, parameters, nil
}

func bindDashboardSQLCorpusInputs(definitions []query.Definition, parameters map[string]any) error {
	for definitionIndex := range definitions {
		definitions[definitionIndex].Compute = append([]query.ComputedField(nil), definitions[definitionIndex].Compute...)
		for computedIndex := range definitions[definitionIndex].Compute {
			computed := &definitions[definitionIndex].Compute[computedIndex]
			computed.Args = append([]query.Argument(nil), computed.Args...)
			for argumentIndex := range computed.Args {
				argument := &computed.Args[argumentIndex]
				if argument.Parameter == "" {
					continue
				}
				value, ok := parameters[argument.Parameter]
				if !ok {
					return fmt.Errorf("dashboard query %q requires parameter %q with no deployed form default",
						definitions[definitionIndex].Name, argument.Parameter)
				}
				*argument = query.Argument{Value: value}
			}
		}
	}
	ResolveQueryContext(definitions, "2026-10-02T00:00:00Z")
	return nil
}
