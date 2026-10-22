package postgresx

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/githubnext/gh-cao/server/internal/query"
)

func requirePostgresCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("error = %v, want PostgreSQL SQLSTATE %s", err, code)
	}
}

func TestReadTransactionResourceCeilings(t *testing.T) {
	store, _ := nativeTestStore(t)
	store.db.SetMaxOpenConns(1)
	for _, tc := range []struct {
		name     string
		settings string
		wantMS   int64
	}{
		{"unlimited", "0", 0},
		{"looser", "120000", 0},
		{"stricter", "5000", 5000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := store.db.ExecContext(t.Context(), `SELECT set_config(name,$1,false)
				FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')`, tc.settings); err != nil {
				t.Fatal(err)
			}
			for _, abort := range []bool{false, true} {
				sentinel := errors.New("rollback")
				err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) > readTransactionTimeout {
						t.Fatal("read callback has no bounded transaction deadline")
					}
					rows, err := reader.(*readTransaction).tx.QueryContext(ctx, `SELECT name,setting::bigint
						FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')`)
					if err != nil {
						return err
					}
					defer func() { _ = rows.Close() }()
					count := 0
					for rows.Next() {
						var name string
						var value int64
						if err := rows.Scan(&name, &value); err != nil {
							return err
						}
						if value <= 0 || value > readTransactionTimeout.Milliseconds() || (tc.wantMS != 0 && value != tc.wantMS) {
							t.Errorf("%s = %dms, stricter ceiling = %d", name, value, tc.wantMS)
						}
						count++
					}
					if err := rows.Err(); err != nil {
						return err
					}
					if count != 3 {
						t.Fatalf("configured %d timeout settings, want 3", count)
					}
					if abort {
						return sentinel
					}
					return nil
				})
				if (abort && !errors.Is(err, sentinel)) || (!abort && err != nil) {
					t.Fatalf("transaction: %v", err)
				}
				var count int
				if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM pg_settings
					WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout') AND setting=$1`, tc.settings).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 3 {
					t.Fatal("transaction limits leaked to pooled session")
				}
			}
		})
	}
}

func TestReadTransactionPhysicalCancellation(t *testing.T) {
	store, _ := nativeTestStore(t)
	store.db.SetMaxOpenConns(1)
	t.Run("statement", func(t *testing.T) {
		if _, err := store.db.ExecContext(t.Context(), "SET statement_timeout='50ms'"); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
			_, err := reader.(*readTransaction).tx.ExecContext(ctx, "SELECT pg_sleep(2)")
			return err
		})
		requirePostgresCode(t, err, "57014")
		t.Logf("server statement cancellation elapsed=%s ceiling=50ms", time.Since(start))
		if _, err := store.db.ExecContext(t.Context(), "SET statement_timeout=0"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("pool-wait", func(t *testing.T) {
		conn, err := store.db.Conn(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close() }()
		ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
		defer cancel()
		called := false
		start := time.Now()
		err = store.WithReadTransaction(ctx, func(context.Context, NativeReader) error {
			called = true
			return nil
		})
		if !errors.Is(err, context.DeadlineExceeded) || called {
			t.Fatalf("pool admission exceeded caller deadline: callback=%t err=%v", called, err)
		}
		t.Logf("pool wait cancellation elapsed=%s ceiling=50ms", time.Since(start))
	})
	t.Run("caller-deadline", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		start := time.Now()
		err := store.WithReadTransaction(ctx, func(ctx context.Context, reader NativeReader) error {
			tx := reader.(*readTransaction).tx
			var timeout int64
			if err := tx.QueryRowContext(ctx, "SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'").Scan(&timeout); err != nil {
				return err
			}
			if timeout <= 0 || timeout > 100 {
				t.Fatalf("statement timeout ignored caller deadline: %dms", timeout)
			}
			_, err := tx.ExecContext(ctx, "SELECT pg_sleep(2)")
			return err
		})
		if err == nil || time.Since(start) >= 2*time.Second {
			t.Fatalf("caller deadline did not stop physical work: %v", err)
		}
		t.Logf("caller deadline cancellation elapsed=%s ceiling=100ms", time.Since(start))
	})
	t.Run("statistics-lock", func(t *testing.T) {
		store.db.SetMaxOpenConns(2)
		lock, err := store.db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = lock.Rollback() }()
		if _, err := lock.ExecContext(t.Context(), "LOCK TABLE domains IN ACCESS EXCLUSIVE MODE"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.ExecContext(t.Context(), "SET lock_timeout='50ms'"); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
			_, _, err := reader.ExecuteSQLPlanWithOptions(ctx,
				[]query.Definition{{Name: "picked", From: "$domains"}}, []string{"picked"},
				SQLExecutionOptions{ResourceLimits: &SQLResourceLimits{MaxInputRows: 1, MaxOperations: 1, MaxWorkingBytes: 1}})
			return err
		})
		requirePostgresCode(t, err, "55P03")
		if !strings.Contains(err.Error(), "execute SQL resource checks") {
			t.Fatalf("lock timeout did not occur in production statistics execution: %v", err)
		}
		t.Logf("production SQL statistics lock cancellation elapsed=%s ceiling=50ms", time.Since(start))
	})
}

func TestReadTransactionPhysicalSpillMeasurement(t *testing.T) {
	store, _ := nativeTestStore(t)
	store.db.SetMaxOpenConns(1)
	const sortSQL = `SELECT repeat(md5(i::text),10) AS value FROM generate_series(1,20000) AS i ORDER BY value`
	if _, err := store.db.ExecContext(t.Context(), "SET work_mem='64kB'"); err != nil {
		t.Fatal(err)
	}
	err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
		tx := reader.(*readTransaction).tx
		var memory string
		if err := tx.QueryRowContext(ctx, "SHOW work_mem").Scan(&memory); err != nil {
			return err
		}
		if memory != "64kB" {
			t.Fatalf("operator work_mem changed: %s", memory)
		}
		var raw []byte
		if err := tx.QueryRowContext(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+sortSQL).Scan(&raw); err != nil {
			return err
		}
		var report []struct {
			Plan struct {
				TempRead    int64  `json:"Temp Read Blocks"`
				TempWritten int64  `json:"Temp Written Blocks"`
				SortMethod  string `json:"Sort Method"`
				SortSpace   int64  `json:"Sort Space Used"`
				SpaceType   string `json:"Sort Space Type"`
			}
			ExecutionMS float64 `json:"Execution Time"`
		}
		if err := json.Unmarshal(raw, &report); err != nil {
			return err
		}
		if len(report) != 1 {
			t.Fatalf("invalid EXPLAIN report length: %d", len(report))
		}
		measurement := report[0]
		if measurement.Plan.TempWritten <= 0 || measurement.Plan.SpaceType != "Disk" {
			t.Fatalf("synthetic sort did not exercise physical spill: %+v", measurement)
		}
		encoded, err := json.Marshal(measurement)
		if err != nil {
			return err
		}
		t.Logf("synthetic physical measurement rows=20000 work_mem=64kB: %s", encoded)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Run("operator-temp-file-limit", func(t *testing.T) {
		if _, err := store.db.ExecContext(t.Context(), "SET temp_file_limit='64kB'"); err != nil {
			var failure *pgconn.PgError
			if errors.As(err, &failure) && failure.Code == "42501" {
				t.Skip("requires isolated test role with SET privilege on temp_file_limit")
			}
			t.Fatal(err)
		}
		err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
			tx := reader.(*readTransaction).tx
			_, err := tx.ExecContext(ctx, sortSQL)
			return err
		})
		requirePostgresCode(t, err, "53400")
		t.Log("operator temp_file_limit=64kB rejected synthetic spill with SQLSTATE 53400")
	})
}
