package postgresx

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestRelationalSQLExecutesInPostgres(t *testing.T) {
	store, _ := nativeTestStore(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	nativeParents(t.Context(), t, writer)
	for _, id := range []string{"run-1", "run-2"} {
		if err := writer.Append(t.Context(), "$runs", model.Row{"id": id, "workflowId": "workflow", "repositoryId": "repository"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []model.Row{
		{"id": "one", "runId": "run-1", "domain": "example.com", "requestCount": json.Number("3")},
		{"id": "two", "runId": "run-1", "domain": nil, "requestCount": json.Number("4")},
		{"id": "three", "runId": "run-2", "domain": "other.example", "requestCount": json.Number("8")},
	} {
		if err := writer.Append(t.Context(), "$domains", row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.Publish(t.Context(), "sql"); err != nil {
		t.Fatal(err)
	}
	field := "requestCount"
	definitions := []query.Definition{
		{Name: "picked", From: "domains",
			Filter:  &query.Filter{Predicates: []query.Predicate{{Field: "runId", Equals: "run-1"}}},
			Compute: []query.ComputedField{{As: "double", Function: "product", Args: []query.Argument{{Field: &field}, {Value: 2}}}}},
		{Name: "total", From: "picked", Aggregate: &query.Aggregate{By: []string{"runId"}, Values: []query.AggregateValue{{Field: "double", As: "total", Reducer: "sum"}}},
			Select: []query.SelectedField{{Field: "runId"}, {Field: "total"}}},
	}
	resolver := func(name string) (query.SQLRelation, error) {
		return query.SQLRelation{
			SQL: "(SELECT * FROM domains WHERE namespace = {}) AS d", Params: []any{store.namespace}, Order: "ordinal",
			Columns: map[string]query.SQLColumn{
				"id":           {Expression: "id", Presence: "TRUE", Kind: query.SQLText},
				"runId":        {Expression: "run_id", Presence: "TRUE", Kind: query.SQLText},
				"requestCount": {Expression: "request_count", Presence: "TRUE", Kind: query.SQLNumber},
			},
		}, nil
	}
	plan, err := query.CompileSQL(definitions, []string{"total"}, resolver)
	if err != nil {
		t.Fatal(err)
	}
	statement, args, fields, err := plan.OutputStatement("total", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(fields, ",") != "runId,total" {
		t.Fatalf("unexpected typed projection: %v", fields)
	}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
		r := reader.(*readTransaction)
		var run, total string
		var runPresent, totalPresent bool
		if err := r.tx.QueryRowContext(ctx, statement, args...).Scan(&run, &runPresent, &total, &totalPresent); err != nil {
			return err
		}
		if run != "run-1" || total != "14" || !runPresent || !totalPresent {
			t.Errorf("filter/compute/grouping/projection ran incorrectly in Postgres: %s %s %v %v", run, total, runPresent, totalPresent)
		}
		statsSQL, statsArgs, err := plan.StatisticsStatement()
		if err != nil {
			return err
		}
		rows, err := r.tx.QueryContext(ctx, statsSQL, statsArgs...)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		count := 0
		for rows.Next() {
			var relation string
			var size, bytes int64
			if err := rows.Scan(&relation, &size, &bytes); err != nil {
				return err
			}
			if size < 0 || bytes < 0 {
				t.Error("invalid SQL resource accounting")
			}
			count++
		}
		if count == 0 {
			t.Error("resource checks must execute in SQL")
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
}
