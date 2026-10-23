package postgresx

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/query"
)

const dailyAggregateSource = "$daily_workflow_aggregates"

func aggregateWeekStart(now time.Time) time.Time {
	day := dayStart(now)
	return day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
}

func aggregateCutoff(now time.Time) time.Time { return aggregateWeekStart(now).AddDate(0, 0, -14) }

func aggregateMeasures() []entityColumn {
	var columns []entityColumn
	for _, column := range entityTables[dailyAggregateSource].columns {
		if column.kind == "numeric" {
			columns = append(columns, column)
		}
	}
	return columns
}

// Contributions are independent of rich execution retention. An absent run in a
// replacement snapshot is not a deletion; only observed facts replace a prior
// measurement. The same namespace lock protects the ledger, deltas and revision.
func refreshDailyAggregates(ctx context.Context, exec func(context.Context, string, ...any) error, namespace string, now time.Time, runID string, runs, tools, domains string, stagedMetrics bool) error {
	measures := aggregateMeasures()
	expressions := map[string]string{
		"runCount":                "1",
		"successCount":            "CASE WHEN r.conclusion='success' THEN 1 ELSE 0 END",
		"failureCount":            "CASE WHEN r.conclusion='failure' THEN 1 ELSE 0 END",
		"cancelledCount":          "CASE WHEN r.conclusion='cancelled' THEN 1 ELSE 0 END",
		"timedOutCount":           "CASE WHEN r.conclusion='timed_out' THEN 1 ELSE 0 END",
		"skippedCount":            "CASE WHEN r.conclusion='skipped' THEN 1 ELSE 0 END",
		"actionRequiredCount":     "CASE WHEN r.conclusion='action_required' THEN 1 ELSE 0 END",
		"neutralCount":            "CASE WHEN r.conclusion='neutral' THEN 1 ELSE 0 END",
		"startupFailureCount":     "CASE WHEN r.conclusion='startup_failure' THEN 1 ELSE 0 END",
		"observedConclusionCount": "CASE WHEN nullif(btrim(r.conclusion),'') IS NULL THEN 0 ELSE 1 END",
	}
	metrics := map[string]string{
		"agenticDurationSeconds": `CASE WHEN r.status='completed' AND coalesce(r.started_at,r.created_at) IS NOT NULL
			AND coalesce(r.completed_at,r.updated_at) IS NOT NULL THEN greatest(0,extract(epoch FROM
			coalesce(r.completed_at,r.updated_at)-coalesce(r.started_at,r.created_at))) END`,
		"firewallAllowedCalls":     "d.allowed",
		"firewallBlockedCalls":     "d.blocked",
		"mcpToolCalls":             "t.calls",
		"mcpResponseBytes":         "t.bytes",
		"toolCalls":                "t.all_calls",
		"domainCalls":              "d.calls",
		"highPriorityAuditItems":   `NULL::numeric`,
		"mediumPriorityAuditItems": `NULL::numeric`,
	}
	for _, column := range entityTables["$runs"].columns {
		if column.kind == "numeric" {
			metrics[column.field] = "r." + query.SQLIdentifier(column.name)
		}
	}
	var projection, names, negative, positive, sums, updates []string
	for _, column := range measures {
		name := query.SQLIdentifier(column.name)
		names = append(names, name)
		expression, count := expressions[column.field]
		if !count {
			metric := strings.TrimSuffix(strings.TrimSuffix(column.field, "ObservedCount"), "Sum")
			value, exists := metrics[metric]
			if !exists {
				return fmt.Errorf("unregistered daily workflow measure %s", column.field)
			}
			if stagedMetrics && metric != "toolCalls" && metric != "domainCalls" {
				value = "coalesce(m." + query.SQLIdentifier(strings.TrimSuffix(column.name, "_observed_count")+"_sum") + "," + value + ")"
				if strings.HasSuffix(column.field, "Sum") {
					value = "coalesce(m." + name + "," + metrics[metric] + ")"
				}
			}
			switch {
			case metric == "toolCalls" || metric == "domainCalls":
				expression = value
				if strings.HasSuffix(column.field, "ObservedCount") {
					alias := "t"
					if metric == "domainCalls" {
						alias = "d"
					}
					expression = "coalesce(" + alias + ".observations,0)"
				}
			case strings.HasSuffix(column.field, "ObservedCount"):
				expression = "CASE WHEN " + value + " IS NULL THEN coalesce(p." + name + ",0) ELSE 1 END"
			default:
				expression = "coalesce(" + value + ",p." + name + ")"
			}
		} else if column.field != "runCount" {
			expression = "CASE WHEN nullif(btrim(r.conclusion),'') IS NULL THEN coalesce(p." + name + ",0) ELSE " + expression + " END"
		}
		projection = append(projection, expression+" AS "+name)
		negative = append(negative, "-coalesce(p."+name+",0) AS "+name)
		positive = append(positive, "coalesce(n."+name+",0) AS "+name)
		sums = append(sums, "sum("+name+") AS "+name)
		updates = append(updates, name+"=coalesce(a."+name+",0)+excluded."+name)
	}
	day := "(coalesce(r.started_at,r.completed_at,r.created_at,r.run_at) AT TIME ZONE 'UTC')::date"
	if stagedMetrics {
		day = "coalesce(m.day," + day + ")"
	}
	filter := ""
	args := []any{namespace, aggregateCutoff(now), dayStart(now).AddDate(0, 0, 1)}
	if runID != "" {
		filter = " AND r.id=$4"
		args = append(args, runID)
	}
	if err := refreshDailyEvidence(ctx, exec, namespace, now, runID, runs, tools, domains, stagedMetrics, day); err != nil {
		return err
	}
	statement := `CREATE TEMP TABLE daily_contributions_next ON COMMIT DROP AS
		SELECT r.namespace,r.id AS run_id,` + day + ` AS day,r.repository_id,r.workflow_id,` + strings.Join(projection, ",") + `
		FROM ` + query.SQLIdentifier(runs) + ` r LEFT JOIN cao_run_contributions p ON p.namespace=r.namespace AND p.run_id=r.id `
	if stagedMetrics {
		statement += "LEFT JOIN daily_run_metrics m ON m.namespace=r.namespace AND m.run_id=r.id "
	}
	statement += `LEFT JOIN (SELECT namespace,run_id,sum(calls) AS all_calls,count(calls) AS observations,
		sum(mcp_calls) AS calls,sum(mcp_response_bytes) AS bytes
		FROM cao_run_evidence_contributions WHERE namespace=$1 AND source='tools' GROUP BY namespace,run_id) t
		ON t.namespace=r.namespace AND t.run_id=r.id
		LEFT JOIN (SELECT namespace,run_id,sum(calls) AS calls,count(calls) AS observations,sum(allowed_calls) AS allowed,sum(blocked_calls) AS blocked
		FROM cao_run_evidence_contributions WHERE namespace=$1 AND source='domains' GROUP BY namespace,run_id) d ON d.namespace=r.namespace AND d.run_id=r.id `
	statement += `WHERE r.namespace=$1 AND ` + day + ` >= $2 AND ` + day + ` < $3` + filter
	if err := exec(ctx, statement, args...); err != nil {
		return fmt.Errorf("stage daily contributions: %w", err)
	}
	if err := exec(ctx, "CREATE UNIQUE INDEX ON daily_contributions_next(namespace,run_id); ANALYZE daily_contributions_next"); err != nil {
		return err
	}
	// Only the old and new groups of observed runs are touched. No complete
	// aggregate rebuild, including when a correction changes the UTC day.
	statement = `CREATE TEMP TABLE daily_contribution_deltas ON COMMIT DROP AS SELECT namespace,day,repository_id,workflow_id,` + strings.Join(sums, ",") + ` FROM (
		SELECT p.namespace,p.day,p.repository_id,p.workflow_id,` + strings.Join(negative, ",") + ` FROM cao_run_contributions p
		WHERE p.namespace=$1 AND EXISTS(SELECT 1 FROM ` + query.SQLIdentifier(runs) + ` r WHERE r.namespace=p.namespace AND r.id=p.run_id AND ($2='' OR r.id=$2))
		UNION ALL SELECT n.namespace,n.day,n.repository_id,n.workflow_id,` + strings.Join(positive, ",") + ` FROM daily_contributions_next n
		) d GROUP BY namespace,day,repository_id,workflow_id`
	if err := exec(ctx, statement, namespace, runID); err != nil {
		return err
	}
	table := entityTables[dailyAggregateSource]
	bits := strings.Repeat("1", len(table.columns))
	statement = `INSERT INTO daily_workflow_aggregates AS a(namespace,ordinal,present_fields,id,day,repository_id,workflow_id,` + strings.Join(names, ",") + `)
		SELECT namespace,(SELECT coalesce(max(ordinal),-1) FROM daily_workflow_aggregates WHERE namespace=$1)+row_number() OVER(ORDER BY day,repository_id,workflow_id),
		'` + bits + `'::bit varying, json_build_array(namespace,day::text,repository_id,workflow_id)::text,day,repository_id,workflow_id,` + strings.Join(names, ",") + `
		FROM daily_contribution_deltas WHERE namespace=$1
		ON CONFLICT(namespace,day,repository_id,workflow_id) DO UPDATE SET ` + strings.Join(updates, ",")
	if err := exec(ctx, statement, namespace); err != nil {
		return fmt.Errorf("apply daily workflow deltas: %w", err)
	}
	var nulls []string
	for _, column := range measures {
		if strings.HasSuffix(column.field, "Sum") {
			observed := strings.TrimSuffix(column.name, "_sum") + "_observed_count"
			nulls = append(nulls, query.SQLIdentifier(column.name)+"=CASE WHEN "+query.SQLIdentifier(observed)+"=0 THEN NULL ELSE "+query.SQLIdentifier(column.name)+" END")
		}
	}
	if err := exec(ctx, "UPDATE daily_workflow_aggregates a SET "+strings.Join(nulls, ",")+" WHERE namespace=$1 AND EXISTS(SELECT 1 FROM daily_contribution_deltas d WHERE d.namespace=a.namespace AND d.day=a.day AND d.repository_id=a.repository_id AND d.workflow_id=a.workflow_id)", namespace); err != nil {
		return err
	}
	if err := exec(ctx, `DELETE FROM daily_workflow_aggregates WHERE namespace=$1 AND run_count=0`, namespace); err != nil {
		return err
	}
	if err := exec(ctx, `DELETE FROM cao_run_contributions p WHERE p.namespace=$1 AND EXISTS(
		SELECT 1 FROM `+query.SQLIdentifier(runs)+` r WHERE r.namespace=p.namespace AND r.id=p.run_id AND ($2='' OR r.id=$2))`, namespace, runID); err != nil {
		return err
	}
	return exec(ctx, `INSERT INTO cao_run_contributions(namespace,run_id,day,repository_id,workflow_id,`+strings.Join(names, ",")+`)
		SELECT namespace,run_id,day,repository_id,workflow_id,`+strings.Join(names, ",")+` FROM daily_contributions_next`)
}

// Stable event identities make partial evidence pages and late event replays
// additive without retaining tool payloads or depending on rich-detail rows.
func refreshDailyEvidence(ctx context.Context, exec func(context.Context, string, ...any) error, namespace string, now time.Time, runID, runs, tools, domains string, stagedMetrics bool, day string) error {
	from := query.SQLIdentifier(runs) + " r "
	if stagedMetrics {
		from += "LEFT JOIN daily_run_metrics m ON m.namespace=r.namespace AND m.run_id=r.id "
	}
	args := []any{namespace, aggregateCutoff(now), dayStart(now).AddDate(0, 0, 1), runID}
	filter := "r.namespace=$1 AND ($4='' OR r.id=$4)"
	if err := exec(ctx, `DELETE FROM cao_run_evidence_contributions e USING `+from+
		` WHERE e.namespace=r.namespace AND e.run_id=r.id AND `+filter+` AND (`+day+`<$2 OR `+day+`>=$3)`, args...); err != nil {
		return err
	}
	if err := exec(ctx, `UPDATE cao_run_evidence_contributions e SET day=`+day+` FROM `+from+
		` WHERE e.namespace=r.namespace AND e.run_id=r.id AND `+filter+` AND `+day+`>=$2 AND `+day+`<$3 AND e.day<>`+day, args...); err != nil {
		return err
	}
	for _, source := range []struct{ table, source, projection string }{
		{tools, "tools", `e.invocation_count,
			CASE WHEN e.mcp_server IS NOT NULL OR e.tool_type='mcp' THEN e.invocation_count END,
			CASE WHEN e.mcp_server IS NOT NULL OR e.tool_type='mcp' THEN e.response_bytes END,NULL::numeric,NULL::numeric`},
		{domains, "domains", `e.request_count,NULL::numeric,NULL::numeric,
			CASE WHEN e.decision='allowed' THEN e.request_count END,
			CASE WHEN e.decision IN ('blocked','denied') THEN e.request_count END`},
	} {
		eventFrom := query.SQLIdentifier(source.table) + ` e JOIN ` + query.SQLIdentifier(runs) + ` r ON e.namespace=r.namespace AND e.run_id=r.id `
		if stagedMetrics {
			eventFrom += `LEFT JOIN daily_run_metrics m ON m.namespace=r.namespace AND m.run_id=r.id `
		}
		statement := `INSERT INTO cao_run_evidence_contributions(namespace,source,id,run_id,day,calls,mcp_calls,mcp_response_bytes,allowed_calls,blocked_calls)
			SELECT e.namespace,'` + source.source + `',e.id,e.run_id,` + day + `,` + source.projection + `
			FROM ` + eventFrom + `
			WHERE ` + filter + ` AND ` + day + `>=$2 AND ` + day + `<$3
			ON CONFLICT(namespace,source,id,day) DO UPDATE SET calls=excluded.calls,
			mcp_calls=excluded.mcp_calls,mcp_response_bytes=excluded.mcp_response_bytes,
			allowed_calls=excluded.allowed_calls,blocked_calls=excluded.blocked_calls`
		if err := exec(ctx, statement, args...); err != nil {
			return fmt.Errorf("update daily %s evidence ledger: %w", source.source, err)
		}
	}
	return nil
}

func (w *Writer) preserveAggregateParents(ctx context.Context) error {
	for _, table := range []string{"workflows", "repositories"} {
		field := "workflow_id"
		if table == "repositories" {
			field = "repository_id"
		}
		if _, err := w.tx.Exec(ctx, "CREATE TEMP TABLE aggregate_"+table+" ON COMMIT DROP AS SELECT p.* FROM "+table+
			" p WHERE p.namespace=$1 AND EXISTS(SELECT 1 FROM daily_workflow_aggregates a WHERE a.namespace=p.namespace AND a."+field+"=p.id)", w.store.namespace); err != nil {
			return err
		}
	}
	if _, err := w.tx.Exec(ctx, `CREATE TEMP TABLE aggregate_campaigns ON COMMIT DROP AS SELECT p.* FROM campaigns p
		WHERE p.namespace=$1 AND EXISTS(SELECT 1 FROM aggregate_workflows w WHERE w.namespace=p.namespace AND w.campaign_id=p.id)`, w.store.namespace); err != nil {
		return err
	}
	return nil
}

func (w *Writer) restoreAggregateParents(ctx context.Context) error {
	for _, source := range []string{"$campaigns", "$repositories", "$workflows"} {
		table := entityTables[source]
		var columns, projection []string
		columns = append(columns, "namespace", "ordinal", "present_fields")
		projection = append(projection, "p.namespace", "(SELECT coalesce(max(ordinal),-1) FROM "+table.name+" WHERE namespace=$1)+row_number() OVER(ORDER BY p.ordinal)", "p.present_fields")
		for _, column := range table.columns {
			columns = append(columns, query.SQLIdentifier(column.name))
			projection = append(projection, "p."+query.SQLIdentifier(column.name))
		}
		if _, err := w.tx.Exec(ctx, "CREATE TEMP TABLE aggregate_restored_"+table.name+" ON COMMIT DROP AS SELECT p.id FROM aggregate_"+table.name+
			" p WHERE p.namespace=$1 AND NOT EXISTS(SELECT 1 FROM "+table.name+" t WHERE t.namespace=p.namespace AND t.id=p.id)", w.store.namespace); err != nil {
			return err
		}
		if _, err := w.tx.Exec(ctx, "INSERT INTO "+table.name+"("+strings.Join(columns, ",")+") SELECT "+strings.Join(projection, ",")+" FROM aggregate_"+table.name+
			" p WHERE p.namespace=$1 AND NOT EXISTS(SELECT 1 FROM "+table.name+" t WHERE t.namespace=p.namespace AND t.id=p.id)", w.store.namespace); err != nil {
			return err
		}
	}
	return nil
}

func (w *Writer) removeUnusedAggregateParents(ctx context.Context) error {
	for _, parent := range []struct{ table, field string }{{"workflows", "workflowId"}, {"repositories", "repositoryId"}, {"campaigns", "campaignId"}} {
		predicates := []string{"p.namespace=$1", "p.id IN (SELECT id FROM aggregate_restored_" + parent.table + ")"}
		for _, source := range tableNames() {
			table := entityTables[source]
			for _, column := range table.columns {
				if column.field == parent.field {
					predicates = append(predicates, "NOT EXISTS(SELECT 1 FROM "+query.SQLIdentifier(table.name)+
						" c WHERE c.namespace=p.namespace AND c."+query.SQLIdentifier(column.name)+"=p.id)")
				}
			}
		}
		if _, err := w.tx.Exec(ctx, "DELETE FROM "+parent.table+" p WHERE "+strings.Join(predicates, " AND "), w.store.namespace); err != nil {
			return err
		}
	}
	return nil
}
