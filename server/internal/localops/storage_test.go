package localops

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestQueueRetentionPreservesActiveClaimedAndBoundaryJobs(t *testing.T) {
	s := service(t, nil)
	q := s.queue
	q.mu.Lock()
	defer q.mu.Unlock()
	ctx := t.Context()
	if _, err := q.db.ExecContext(ctx, "INSERT OR REPLACE INTO queue_state VALUES('recovery_blocked',?)", recoveryMessage); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(Invocation{ActionID: "complete", Command: "gh workflow run complete", Arguments: map[string]bool{}, Values: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	old := monday(time.Now().Add(-60 * 24 * time.Hour))
	boundary := monday(time.Now().Add(-30 * 24 * time.Hour))
	for _, row := range []struct {
		status, week string
		claimed      bool
	}{
		{"completed", old, false}, {"failed", old, false}, {"canceled", old, false}, {"timed-out", old, false},
		{"queued", old, false}, {"running", old, false}, {"failed", old, true}, {"completed", monday(time.Now()), false}, {"completed", boundary, false},
	} {
		result, e := q.db.ExecContext(ctx, "INSERT INTO jobs(invocation,fingerprint,status,created_at,completion_week,output_bytes,output_chunks) VALUES(?,'seed',?,?,?,1,1)", string(raw), row.status, time.Now().UnixMilli(), row.week)
		if e != nil {
			t.Fatal(e)
		}
		id, e := result.LastInsertId()
		if e != nil {
			t.Fatal(e)
		}
		if _, e = q.db.ExecContext(ctx, "INSERT INTO output VALUES(?,1,'stdout','x')", id); e != nil {
			t.Fatal(e)
		}
		if row.claimed {
			if _, e = q.db.ExecContext(ctx, "INSERT INTO execution_claims VALUES(?)", id); e != nil {
				t.Fatal(e)
			}
		}
	}
	if err = q.retainLocked(ctx); err != nil {
		t.Fatal(err)
	}
	if q.revision == 0 {
		t.Fatal("idle retention did not publish a new queue revision")
	}
	for _, query := range []string{"SELECT count(*) FROM jobs", "SELECT count(*) FROM output"} {
		var count int
		if err = q.db.QueryRowContext(ctx, query).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 5 {
			t.Fatalf("%s: %d", query, count)
		}
	}
	var claims int
	if err = q.db.QueryRowContext(ctx, "SELECT count(*) FROM execution_claims").Scan(&claims); err != nil || claims != 1 {
		t.Fatalf("active claim was lost: %d %v", claims, err)
	}
}

func TestQueueOutputStorageCapsSequenceAndPreview(t *testing.T) {
	s := service(t, nil)
	q := s.queue
	raw, err := json.Marshal(Invocation{ActionID: "complete", Command: "gh workflow run complete", Arguments: map[string]bool{}, Values: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	inserted, err := q.db.ExecContext(t.Context(), "INSERT INTO jobs(invocation,fingerprint,status,created_at) VALUES(?,'seed','running',?)", string(raw), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	id, err := inserted.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	for range 64 {
		if err = q.append(t.Context(), id, "stdout", strings.Repeat("x", 16<<10)); err != nil {
			t.Fatal(err)
		}
	}
	if err = q.append(t.Context(), id, "stdout", "overflow"); err != nil {
		t.Fatal(err)
	}
	detail, err := q.detail(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	if detail["outputBytes"] != 1<<20 || detail["outputChunks"] != 64 || detail["outputTruncated"] != true || len(text(detail["stdout"])) != 64<<10 {
		t.Fatal(detail["outputBytes"], detail["outputChunks"], detail["outputTruncated"], len(text(detail["stdout"])))
	}
	output, err := q.output(t.Context(), id, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	rows := output.([]any)
	if len(rows) != 2 || mapping(rows[0])["sequence"] != int64(2) || mapping(rows[1])["sequence"] != int64(3) {
		t.Fatal(rows)
	}
}
