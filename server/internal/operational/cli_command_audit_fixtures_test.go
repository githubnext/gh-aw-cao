package operational_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sqlitedriver "modernc.org/sqlite"

	"github.com/githubnext/gh-cao/server/internal/operational"
	"github.com/githubnext/gh-cao/server/internal/operational/postgres"
	"github.com/githubnext/gh-cao/server/internal/operational/sqlite"
)

type auditFixture struct {
	queue, executor operational.AuditedCLICommandQueue
	store           operational.AuditLog
	db              *sql.DB
	namespace       string
	dialect         string
	gateName        string
	sqlitePath      string
	gateKey         int32
	entered         chan struct{}
	release         chan struct{}
	enterOnce       sync.Once
	releaseOnce     sync.Once
	fail            bool
}

var auditGateID atomic.Int32

func newAuditFixture(t *testing.T, dialect string) *auditFixture {
	t.Helper()
	f := &auditFixture{dialect: dialect, entered: make(chan struct{}), release: make(chan struct{})}
	f.namespace = "audit_test_" + strings.ToLower(rand.Text())
	f.gateName = fmt.Sprintf("audit_gate_%d", auditGateID.Add(1))
	var web, executor operational.CLICommandQueues
	if dialect == "sqlite" {
		if err := sqlitedriver.RegisterScalarFunction(f.gateName, 0, func(*sqlitedriver.FunctionContext, []driver.Value) (driver.Value, error) {
			f.enterOnce.Do(func() { close(f.entered) })
			select {
			case <-f.release:
			case <-t.Context().Done():
				return nil, t.Context().Err()
			case <-time.After(10 * time.Second):
				return nil, errors.New("audit test gate timed out")
			}
			if f.fail {
				return nil, errors.New("injected audit failure")
			}
			return int64(1), nil
		}); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "audit.sqlite")
		f.sqlitePath = path
		first, err := sqlite.Open(t.Context(), path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = first.Close() })
		second, err := sqlite.Open(t.Context(), path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = second.Close() })
		f.db, err = sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		web, executor, f.store = first, second, first
	} else {
		dsn := os.Getenv("POSTGRES_URL")
		if dsn == "" {
			t.Skip("POSTGRES_URL is required for real PostgreSQL audit admission tests")
		}
		// Trigger-based fault injection must not contend with another test
		// package's schema initialization or alter its audit table.
		admin, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.ExecContext(t.Context(), "CREATE SCHEMA "+f.namespace); err != nil {
			_ = admin.Close()
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := admin.ExecContext(ctx, "DROP SCHEMA "+f.namespace+" CASCADE"); err != nil {
				t.Error(err)
			}
			_ = admin.Close()
		})
		if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
			parsed, err := url.Parse(dsn)
			if err != nil {
				t.Fatal(err)
			}
			query := parsed.Query()
			query.Set("search_path", f.namespace)
			parsed.RawQuery = query.Encode()
			dsn = parsed.String()
		} else {
			dsn += " search_path=" + f.namespace
		}
		first, err := postgres.New(t.Context(), dsn, f.namespace, postgres.Config{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := first.DeleteNamespace(ctx); err != nil {
				t.Error(err)
			}
			_ = first.Close()
		})
		second, err := postgres.Open(t.Context(), dsn, f.namespace, postgres.Config{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = second.Close() })
		f.db, err = sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal(err)
		}
		web, executor, f.store = first, second, first
	}
	t.Cleanup(func() { _ = f.db.Close() })
	options := operational.CLICommandQueueOptions{MaxConcurrency: 1}
	for source, target := range map[operational.CLICommandQueues]*operational.AuditedCLICommandQueue{web: &f.queue, executor: &f.executor} {
		queue, err := source.OpenCLICommandQueue(t.Context(), "commands", options)
		if err != nil {
			t.Fatal(err)
		}
		*target = queue.(operational.AuditedCLICommandQueue)
	}
	return f
}

func (f *auditFixture) exec(t *testing.T, statement string, args ...any) {
	t.Helper()
	if _, err := f.db.ExecContext(t.Context(), statement, args...); err != nil {
		t.Fatal(err)
	}
}

// gate blocks inside the production audit INSERT, after the queue mutation
// has happened but before either can commit. The executor uses another store.
func (f *auditFixture) gate(t *testing.T, fail bool) (wait, release func()) {
	t.Helper()
	f.fail = fail
	if f.dialect == "sqlite" {
		f.exec(t, fmt.Sprintf(`CREATE TRIGGER audit_test_gate BEFORE INSERT ON cao_operational_audit_events BEGIN SELECT %s(); END`, f.gateName))
		release = func() { f.releaseOnce.Do(func() { close(f.release) }) }
		wait = func() {
			select {
			case <-f.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("admission did not reach the audit INSERT")
			}
		}
		t.Cleanup(func() {
			release()
			f.clearGate(t)
		})
		return wait, release
	}
	lock, err := f.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	key := int32(time.Now().UnixNano() % 2147483647)
	f.gateKey = key
	if _, err := lock.ExecContext(t.Context(), `SELECT pg_advisory_xact_lock(9132,$1)`, key); err != nil {
		_ = lock.Rollback()
		t.Fatal(err)
	}
	release = func() { f.releaseOnce.Do(func() { _ = lock.Rollback() }) }
	raise := ""
	if fail {
		raise = `RAISE EXCEPTION 'injected audit failure';`
	}
	// All interpolated identifiers and the namespace are generated here, not inputs.
	name := f.namespace
	f.exec(t, fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.namespace='%s' THEN PERFORM pg_advisory_xact_lock(9132,%d); %s END IF; RETURN NEW; END $$;
		CREATE TRIGGER %s BEFORE INSERT ON cao_operational_audit_events FOR EACH ROW EXECUTE FUNCTION %s()`,
		name, name, key, raise, name, name))
	t.Cleanup(func() {
		release()
		f.clearGate(t)
	})
	wait = func() {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			var waiting bool
			if err := f.db.QueryRowContext(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=9132 AND objid=$1 AND NOT granted)`, key).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("admission did not reach the audit INSERT")
	}
	return wait, release
}

func (f *auditFixture) clearGate(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	statement := `DROP TRIGGER IF EXISTS audit_test_gate`
	if f.dialect == "postgres" {
		statement = fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON cao_operational_audit_events; DROP FUNCTION IF EXISTS %s()`, f.namespace, f.namespace)
	}
	if _, err := f.db.ExecContext(ctx, statement); err != nil {
		t.Error(err)
	}
}

func (f *auditFixture) counts(t *testing.T) (commands, events int) {
	t.Helper()
	where, args := "", []any{}
	if f.dialect == "postgres" {
		where, args = " WHERE namespace=$1", []any{f.namespace}
	}
	for table, target := range map[string]*int{"cao_operational_cli_commands": &commands, "cao_operational_audit_events": &events} {
		if err := f.db.QueryRowContext(t.Context(), "SELECT count(*) FROM "+table+where, args...).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	return commands, events
}
