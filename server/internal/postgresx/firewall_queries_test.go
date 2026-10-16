package postgresx

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func firewallDefinitions(t *testing.T) []query.Definition {
	t.Helper()
	content, err := os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	content, err = os.ReadFile("../../../dashboard/site/dashboard-fragments/controls.json")
	if err != nil {
		t.Fatal(err)
	}
	var controls struct {
		Queries []query.Definition `json:"queries"`
	}
	if err := json.Unmarshal(content, &controls); err != nil {
		t.Fatal(err)
	}
	for _, definition := range controls.Queries {
		if strings.HasPrefix(definition.Name, "firewall-") {
			definitions = append(definitions, definition)
		}
	}
	return definitions
}

func TestFirewallSQLUsesOnlyDomainsAndRuns(t *testing.T) {
	reader := &readTransaction{store: &Store{namespace: "firewall-plan"}}
	var sources []string
	plan, err := query.CompileSQL(firewallDefinitions(t), []string{
		"firewall-domain-totals", "firewall-most-blocked-domains", "firewall-domain-workflows",
	}, func(name string) (query.SQLRelation, error) {
		sources = append(sources, name)
		return reader.entitySQLSource(name)
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(sources)
	if !reflect.DeepEqual(sources, []string{"$domains", "$runs"}) {
		t.Fatalf("Firewall must not scan other event families: %v", sources)
	}
	computations := 0
	for _, step := range plan.Steps {
		if step.Query == "firewall-observations" && step.Operation == "compute" {
			computations++
		}
	}
	if computations != 2 || len(plan.CTEList) > 15 || strings.Contains(plan.CTEs, "UNION ALL") {
		t.Fatalf("Firewall must remain a compact native relational plan: computations=%d CTEs=%d",
			computations, len(plan.CTEList))
	}
	t.Logf("Firewall SQL: %d CTEs, %d bytes, %d source tables", len(plan.CTEList), len(plan.CTEs), len(sources))
}

func TestFirewallTotalsExecuteNatively(t *testing.T) {
	store, _ := nativeTestStore(t)
	domains := make([]model.Row, 3000, 3003)
	tools := make([]model.Row, 3000)
	for index := range domains {
		decision, eventType := "denied", "firewall.http_access"
		if index%3 == 0 {
			decision, eventType = "allowed", "firewall.http_access"
		}
		domains[index] = model.Row{
			"id": fmt.Sprintf("domain-%04d", index), "runId": "run",
			"source": "firewall", "type": eventType, "domain": "example.com",
			"decision": decision, "requestCount": index % 5,
		}
		tools[index] = model.Row{
			"id": fmt.Sprintf("tool-%04d", index), "runId": "run",
			"source": "mcp", "type": "mcp.tool_call", "mcpServer": "github", "mcpTool": "list_issues",
		}
	}
	domains = append(domains,
		model.Row{"id": "null-count", "runId": "run", "source": "firewall", "type": "firewall.http_access",
			"domain": "example.com", "decision": "denied", "requestCount": nil},
		model.Row{"id": "missing-count", "runId": "run", "source": "firewall", "type": "firewall.http_access",
			"domain": "example.com", "decision": "denied"},
		model.Row{"id": "other-source", "runId": "run", "source": "other", "type": "firewall.http_access",
			"domain": "other.example", "decision": "denied", "requestCount": 999},
	)
	nativeSeed(t.Context(), t, store, map[string][]model.Row{"$domains": domains, "$tools": tools})
	started := time.Now()
	results, metrics, err := store.ExecuteSQLPlan(t.Context(), firewallDefinitions(t), []string{
		"firewall-domain-totals", "firewall-most-blocked-domains", "firewall-domain-workflows",
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := []model.Row{{
		"domain": "example.com", "run": json.Number("1"),
		"accepted": json.Number("2000"), "blocked": json.Number("4002"),
	}}
	for _, name := range []string{"firewall-domain-totals", "firewall-most-blocked-domains"} {
		if !reflect.DeepEqual(results[name].Rows, expected) {
			t.Errorf("%s = %#v, want %#v", name, results[name].Rows, expected)
		}
	}
	workflows := results["firewall-domain-workflows"].Rows
	if len(workflows) != 1 || workflows[0]["repository"] != "api" ||
		workflows[0]["runs"] != json.Number("1") || workflows[0]["blocked"] != json.Number("4002") {
		t.Fatalf("workflow drilldown changed: %#v", workflows)
	}
	if len(metrics.FallbackOperations) != 0 || !slices.Contains(metrics.PushedDown, "sql-plan") {
		t.Fatalf("Firewall must execute entirely in native SQL: %#v", metrics)
	}
	if metrics.PeakWorkingRows > len(domains) || metrics.Operations > len(domains)*12 {
		t.Fatalf("Firewall cost must depend only on its domain evidence: %#v", metrics)
	}
	t.Logf("Firewall execution: %s, operations=%d, peak rows=%d, peak bytes=%d",
		time.Since(started), metrics.Operations, metrics.PeakWorkingRows, metrics.PeakWorkingBytes)
}
