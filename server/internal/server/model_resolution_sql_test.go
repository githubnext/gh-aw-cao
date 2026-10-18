package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
)

// Configured-model resolution facts are optional Audit columns. A failed
// resolution keeps its resolved model unknown, absent fields stay unknown, and
// a routed session without resolution is not counted as missing evidence.
func TestModelResolutionContractUsesPostgres(t *testing.T) {
	store := integrationDatabase(t)
	audit := func(id, run string, sequence int, fields model.Row) model.Row {
		row := model.Row{"id": id, "runId": run, "sourceSequence": sequence, "source": "unified-session", "phase": "agent"}
		for key, value := range fields {
			row[key] = value
		}
		return row
	}
	seedDatabase(t, store, map[string]model.Source{
		"$repositories": {Rows: []model.Row{{"id": "repository", "owner": "github", "name": "gh-aw"}}},
		"$workflows": {Rows: []model.Row{{"id": "workflow", "repositoryId": "repository",
			"path": ".github/workflows/smoke-pi-sub-agents.md"}}},
		"$runs": {Rows: []model.Row{
			{"id": "covered", "workflowId": "workflow", "repositoryId": "repository", "owner": "github",
				"repository": "gh-aw", "githubRunId": "990000003", "attempt": 1},
			{"id": "routed", "workflowId": "workflow", "repositoryId": "repository", "owner": "github",
				"repository": "gh-aw", "githubRunId": "39091105929", "attempt": 1},
		}},
		"$audits": {Rows: []model.Row{
			audit("covered-format", "covered", 0, model.Row{"type": "session.format", "status": "1", "phase": "conclusion"}),
			audit("covered-info", "covered", 3, model.Row{"type": "workflow.info", "required": true, "phase": "activation"}),
			audit("covered-main", "covered", 1, model.Row{"type": "model.resolution", "sourceEngine": "pi",
				"resolutionRole": "main", "resolutionConfiguredModel": "copilot/gpt-5.3", "provider": "copilot",
				"status": "failed", "code": "model_unavailable"}),
			audit("covered-mini", "covered", 2, model.Row{"type": "model.resolution", "sourceEngine": "pi",
				"resolutionRole": "mini-whoami", "resolutionConfiguredModel": "copilot/gpt-5-mini",
				"resolutionResolvedModel": "gpt-5-mini", "provider": nil, "status": "exact"}),
			audit("routed-format", "routed", 0, model.Row{"type": "session.format", "status": "1", "phase": "conclusion"}),
			audit("routed-info", "routed", 2, model.Row{"type": "workflow.info", "required": true, "phase": "activation"}),
			audit("routed-selection", "routed", 1, model.Row{"type": "firewall.model_routing", "routingStage": "selection"}),
		}},
	})
	definitions, parameters, err := dashboardSQLCorpus()
	if err != nil {
		t.Fatal(err)
	}
	if err := bindDashboardSQLCorpusInputs(definitions, parameters); err != nil {
		t.Fatal(err)
	}
	names := []string{"routing-resolutions", "routing-resolution-coverage", "routing-resolution-failures", "routing-alias-moves"}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.NativeReader) error {
		sources, metrics, err := reader.ExecuteSQLPlan(ctx, definitions, names)
		if err != nil {
			return err
		}
		if len(metrics.FallbackOperations) != 0 {
			t.Fatalf("model resolution used Go fallback operations: %v", metrics.FallbackOperations)
		}
		resolutions := map[string]model.Row{}
		for _, row := range sources["routing-resolutions"].Rows {
			resolutions[row["resolution-role-label"].(string)] = row
		}
		if len(resolutions) != 2 {
			t.Fatalf("routing-resolutions = %#v", sources["routing-resolutions"].Rows)
		}
		failed := resolutions["main"]
		if failed["resolved-model-label"] != "unknown" || failed["resolution-resolved-model"] != nil ||
			failed["resolution-cause"] != "model_unavailable" || failed["resolution-status"] != "failed" ||
			failed["configured-model"] != "copilot/gpt-5.3" || failed["resolution-engine"] != "pi" {
			t.Errorf("failed resolution = %#v", failed)
		}
		exact := resolutions["mini-whoami"]
		if exact["resolved-model-label"] != "gpt-5-mini" || exact["resolution-provider"] != "unknown" ||
			exact["resolution-cause"] != nil || exact["configured-to-resolved"] != "copilot/gpt-5-mini → gpt-5-mini" {
			t.Errorf("exact resolution = %#v", exact)
		}
		coverage := sources["routing-resolution-coverage"].Rows
		want := map[string]json.Number{"runs": "2", "resolution-runs": "1", "routed-runs": "1",
			"routed-without-resolution": "1", "missing-resolution": "0", "failed-runs": "1", "resolution-records": "2"}
		if len(coverage) != 1 {
			t.Fatalf("routing-resolution-coverage = %#v", coverage)
		}
		for key, value := range want {
			if coverage[0][key] != value {
				t.Errorf("coverage %s = %#v, want %s", key, coverage[0][key], value)
			}
		}
		failures := sources["routing-resolution-failures"].Rows
		if len(failures) != 1 || failures[0]["resolution-cause"] != "model_unavailable" ||
			failures[0]["affected-runs"] != json.Number("1") || failures[0]["configured-model"] != "copilot/gpt-5.3" {
			t.Errorf("routing-resolution-failures = %#v", failures)
		}
		moves := sources["routing-alias-moves"].Rows
		if len(moves) != 1 || moves[0]["configured-model"] != "copilot/gpt-5-mini" || moves[0]["alias-change"] != "stable" ||
			moves[0]["first-run"] != nil {
			t.Errorf("routing-alias-moves = %#v", moves)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
