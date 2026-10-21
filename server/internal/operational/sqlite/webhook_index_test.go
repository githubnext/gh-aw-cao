package sqlite

import (
	"strings"
	"testing"
)

func TestFleetQueuePlansUseBoundedIndexes(t *testing.T) {
	rig := newRig(t, specCase{})
	for _, test := range []struct {
		query string
		index string
	}{
		{`SELECT id FROM jobs WHERE state='ready' AND not_before<=1 AND expires_at>1
		 AND created_at<=1 AND tenant||'!'||json_extract(document,'$.subscription.id')>'a'
		 ORDER BY tenant||'!'||json_extract(document,'$.subscription.id'),created_at,id LIMIT 1`, "batch_rotation"},
		{`SELECT count(*),coalesce(sum(bytes),0) FROM jobs WHERE tenant='a'`, "COVERING INDEX tenant_capacity"},
		{`SELECT id FROM jobs WHERE state='ready' AND
		 (json_extract(document,'$.attempt')>=json_extract(document,'$.subscription.delivery.maxAttempts'))=1
		 ORDER BY created_at,id LIMIT 1`, "exhausted_attempts"},
	} {
		rows, err := rig.q.db.QueryContext(t.Context(), "EXPLAIN QUERY PLAN "+test.query)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := rows.Close(); err != nil {
				t.Error(err)
			}
		}()
		var details []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			details = append(details, detail)
		}
		err = rows.Err()
		if err != nil {
			t.Fatal("read queue plan", err)
		}
		plan := strings.Join(details, "\n")
		if !strings.Contains(plan, test.index) || strings.Contains(plan, "USE TEMP B-TREE") {
			t.Fatalf("queue query lost its bounded indexed plan: %s", plan)
		}
	}
}
