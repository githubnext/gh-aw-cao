package postgresx

import (
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func testToolUsage(id, run, revision, at string) model.Row {
	return model.Row{
		"id": id, "runId": run, "toolId": "observed-tool", "source": "mcp", "evidenceRevision": revision,
		"eventCount": 20, "callCount": 10, "outcomeCount": 10, "successCount": 0, "failedCount": 0,
		"incompleteCount": 10, "unknownOutcomeCount": 0, "unmatchedCount": 0, "ambiguousCount": 0,
		"requestBytes": 100, "requestBytesCount": 10, "responseBytes": 0, "responseBytesCount": 10,
		"latencySum": 0, "latencyCount": 0, "timestamp": at, "lastTimestamp": at, "observedAt": at,
	}
}

func TestToolUsageRejectsOldEventGrain(t *testing.T) {
	if err := validateToolProjection("$tools", model.Row{"id": "event", "runId": "run", "type": "tool.call"}); err == nil {
		t.Fatal("old Tool event rows must not be admitted by the fresh contract")
	}
	row := testToolUsage("usage", "run", "revision", time.Now().UTC().Format(time.RFC3339))
	if err := validateToolProjection("$tools", row); err != nil {
		t.Fatal(err)
	}
	row["failedCount"] = 10
	if err := validateToolProjection("$tools", row); err == nil {
		t.Fatal("incomplete outcomes must not also be counted as confirmed failures")
	}
}

func TestToolUsageWeeklyShards(t *testing.T) {
	store, _ := nativeTestStore(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	now := time.Now().UTC()
	older := now.AddDate(0, 0, -14)
	for _, input := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repository"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository"}},
		{"$toolIdentities", model.Row{"id": "observed-tool", "name": "read", "mcpServer": "github", "observedAt": now.Format(time.RFC3339)}},
	} {
		if err := writer.Append(t.Context(), input.source, input.row); err != nil {
			t.Fatal(err)
		}
	}
	for _, input := range []struct {
		run string
		at  time.Time
	}{{"older", older}, {"current", now}} {
		at := input.at.Format(time.RFC3339)
		revision := "revision:" + input.run
		if err := writer.Append(t.Context(), "$runs", model.Row{"id": input.run, "workflowId": "workflow",
			"repositoryId": "repository", "createdAt": at, "toolUsageRevision": revision}); err != nil {
			t.Fatal(err)
		}
		if err := writer.Append(t.Context(), "$tools", testToolUsage("usage:"+input.run, input.run, revision, at)); err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"tool.call", "tool.error"} {
			status := "started"
			if kind == "tool.error" {
				status = "incomplete"
			}
			bytes, known := 0, 0
			if kind == "tool.call" {
				bytes, known = 100, 10
			}
			if err := writer.Append(t.Context(), "$toolCounters", model.Row{
				"id": kind + ":" + input.run, "runId": input.run, "usageId": "usage:" + input.run,
				"evidenceRevision": revision, "eventCount": 10, "type": kind, "status": status,
				"requestBytes": bytes, "requestBytesCount": known, "responseBytes": 0, "responseBytesCount": known,
				"timestamp": at, "lastTimestamp": at, "observedAt": at,
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := writer.Publish(t.Context(), "tool-usage-sharding"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"tools", "tool_counters"} {
		var partitions int
		if err := store.db.QueryRowContext(t.Context(), "SELECT count(DISTINCT tableoid) FROM "+table+" WHERE namespace=$1",
			store.namespace).Scan(&partitions); err != nil || partitions != 2 {
			t.Fatalf("%s did not route into two weekly shards: %d %v", table, partitions, err)
		}
	}
	for table, expected := range map[string]int{"runs": 2, "tools": 2, "tool_counters": 4, "tool_identities": 1} {
		var estimated float64
		if err := store.db.QueryRowContext(t.Context(), `SELECT reltuples FROM pg_class
			WHERE relnamespace=current_schema()::regnamespace AND relname=$1`, table).Scan(&estimated); err != nil {
			t.Fatal(err)
		}
		if estimated != float64(expected) {
			t.Errorf("%s publication did not refresh planner cardinality: got %v, want %d", table, estimated, expected)
		}
		if table == "tool_identities" {
			continue
		}
		var rows, unmeasured int
		if err := store.db.QueryRowContext(t.Context(), `SELECT sum(c.reltuples)::int,
			count(*) FILTER (WHERE c.reltuples < 0)
			FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
			WHERE i.inhparent=$1::regclass`, table).Scan(&rows, &unmeasured); err != nil {
			t.Fatal(err)
		}
		if rows != expected || unmeasured != 0 {
			t.Errorf("%s publication omitted weekly partition statistics: rows=%d unmeasured=%d", table, rows, unmeasured)
		}
	}
	var identities int
	if err := store.db.QueryRowContext(t.Context(), "SELECT count(*) FROM tool_identities WHERE namespace=$1",
		store.namespace).Scan(&identities); err != nil || identities != 1 {
		t.Fatalf("observed identity must be shared, not repeated per weekly shard: %d %v", identities, err)
	}
}
