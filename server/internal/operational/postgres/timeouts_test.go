package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTransactionTimeoutsPreserveOperatorCeilings(t *testing.T) {
	for _, configured := range []struct {
		name                  string
		statement, lock, idle string
		maximum               [3]time.Duration
	}{
		{"stricter", "1s", "100ms", "2s", [3]time.Duration{time.Second, 100 * time.Millisecond, 2 * time.Second}},
		{"disabled", "0", "0", "0", [3]time.Duration{4 * time.Second, 4 * time.Second, 4 * time.Second}},
		{"mixed", "10min", "100ms", "0", [3]time.Duration{4 * time.Second, 100 * time.Millisecond, 4 * time.Second}},
	} {
		t.Run(configured.name, func(t *testing.T) {
			s, _ := testStore(t, Config{})
			s.db.SetMaxOpenConns(1)
			// Pin the connection so session settings and transaction-local
			// overrides are checked on the same production pool connection.
			if _, err := s.db.ExecContext(t.Context(), `SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),set_config('idle_in_transaction_session_timeout',$3,false)`,
				configured.statement, configured.lock, configured.idle); err != nil {
				t.Fatal(err)
			}
			var before, after [3]string
			readSettings := func(target *[3]string) error {
				return s.db.QueryRowContext(t.Context(), `SELECT current_setting('statement_timeout'),current_setting('lock_timeout'),current_setting('idle_in_transaction_session_timeout')`).
					Scan(&target[0], &target[1], &target[2])
			}
			if err := readSettings(&before); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
			defer cancel()
			if err := s.transact(ctx, func(tx *transaction) error {
				var actual [3]string
				if err := tx.tx.QueryRowContext(ctx, `SELECT current_setting('statement_timeout'),current_setting('lock_timeout'),current_setting('idle_in_transaction_session_timeout')`).
					Scan(&actual[0], &actual[1], &actual[2]); err != nil {
					return err
				}
				for i, setting := range actual {
					duration, err := time.ParseDuration(setting)
					if err != nil || duration <= 0 || duration > configured.maximum[i] {
						t.Errorf("timeout %d=%q exceeds %v or is unbounded: %v", i, setting, configured.maximum[i], err)
					}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := readSettings(&after); err != nil {
				t.Fatal(err)
			}
			if after != before {
				t.Fatalf("transaction-local limits leaked into session: before=%v after=%v", before, after)
			}
		})
	}
}

func TestTransactionHonorsStricterStatementTimeout(t *testing.T) {
	s, _ := testStore(t, Config{})
	s.db.SetMaxOpenConns(1)
	if _, err := s.db.ExecContext(t.Context(), `SET statement_timeout='50ms'`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	started := time.Now()
	err := s.transact(ctx, func(tx *transaction) error {
		_, err := tx.tx.ExecContext(ctx, `SELECT pg_sleep(1)`)
		return err
	})
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || failure.Code != "57014" || time.Since(started) > 750*time.Millisecond {
		t.Fatalf("stricter statement timeout was widened: elapsed=%v err=%v", time.Since(started), err)
	}
}

func TestTransactionHonorsStricterNamespaceLockTimeout(t *testing.T) {
	s, dsn := testStore(t, Config{})
	peer, err := Open(t.Context(), dsn, s.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Close() }()
	s.db.SetMaxOpenConns(1)
	if _, err := s.db.ExecContext(t.Context(), `SET lock_timeout='50ms'`); err != nil {
		t.Fatal(err)
	}
	lock, err := peer.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Rollback() }()
	if _, err := lock.ExecContext(t.Context(), `SELECT namespace FROM cao_operational_namespaces WHERE namespace=$1 FOR UPDATE`, s.namespace); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	started := time.Now()
	err = s.transact(ctx, func(*transaction) error {
		t.Error("transaction entered while the namespace was locked")
		return nil
	})
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || failure.Code != "55P03" || time.Since(started) > 750*time.Millisecond {
		t.Fatalf("stricter lock timeout was widened: elapsed=%v err=%v", time.Since(started), err)
	}
}
