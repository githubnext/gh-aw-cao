package server

import (
	"context"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/postgresx"
)

// Configured-model resolution facts are optional Audit columns. A failed
// resolution keeps its resolved model unknown, absent fields stay unknown, and
// it appears in Problems with its cause and run link; a routed session without
// resolution is not reported as a problem.
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
				"repository": "gh-aw", "githubRunId": "990000003", "attempt": 1,
				"workflowPath": ".github/workflows/smoke-pi-sub-agents.md"},
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
	names := []string{"routing-resolutions", "routing-resolution-failure-records", "routing-problems"}
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
		failures := sources["routing-resolution-failure-records"].Rows
		if len(failures) != 1 || failures[0]["run"] != "990000003" || failures[0]["resolution-cause"] != "model_unavailable" ||
			failures[0]["configured-model"] != "copilot/gpt-5.3" || failures[0]["full-repository"] != "github/gh-aw" {
			t.Errorf("routing-resolution-failure-records = %#v", failures)
		}
		problems := sources["routing-problems"].Rows
		if len(problems) != 1 || problems[0]["run"] != "990000003" || problems[0]["problem-kind"] != "resolution failure" ||
			problems[0]["problem-cause"] != "model_unavailable" || problems[0]["full-repository"] != "github/gh-aw" ||
			problems[0]["workflow"] != ".github/workflows/smoke-pi-sub-agents.md" || problems[0]["observed-at"] != nil {
			t.Errorf("routing-problems = %#v", problems)
		}
		link, _ := problems[0]["routing-dashboard-link"].(map[string]any)
		if link["dashboard-href"] != "#page-routing-run?routing-run=github%2Fgh-aw%3A990000003" {
			t.Errorf("routing-problems link = %#v", problems[0]["routing-dashboard-link"])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
