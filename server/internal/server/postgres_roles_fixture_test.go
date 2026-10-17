package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
)

type postgresRoles struct {
	admin                    *sql.DB
	schema, owner, namespace string
	runtime, retention       string
	reader, ownerDSN         string
	runtimeDSN, retentionDSN string
	readerDSN                string
}

func rolesConnectionString(config *pgx.ConnConfig) string {
	u := url.URL{Scheme: "postgres", User: url.UserPassword(config.User, config.Password),
		Host: net.JoinHostPort(config.Host, strconv.Itoa(int(config.Port))), Path: "/" + config.Database}
	q := url.Values{"sslmode": {"disable"}}
	for key, value := range config.RuntimeParams {
		q.Set(key, value)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func newPostgresRoles(t *testing.T) postgresRoles {
	t.Helper()
	endpoint := os.Getenv("POSTGRES_URL")
	if endpoint == "" {
		t.Skip("POSTGRES_URL is required for real PostgreSQL role tests")
	}
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if config.Host != "127.0.0.1" && config.Host != "::1" {
		t.Fatal("role tests require an isolated numeric-loopback PostgreSQL administrator")
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	prefix := "cao_roles_" + hex.EncodeToString(nonce[:])
	f := postgresRoles{schema: prefix, owner: prefix + "_owner", namespace: "deployment",
		runtime: prefix + "_runtime", retention: prefix + "_retention", reader: prefix + "_reader"}
	f.admin = stdlib.OpenDB(*config.Copy())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := f.admin.ExecContext(ctx, "DROP SCHEMA "+pgx.Identifier{f.schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		for _, role := range []string{f.runtime, f.retention, f.reader, f.owner} {
			if _, err := f.admin.ExecContext(ctx, "DROP OWNED BY "+pgx.Identifier{role}.Sanitize()); err != nil {
				t.Error(err)
			}
			if _, err := f.admin.ExecContext(ctx, "DROP ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
				t.Error(err)
			}
		}
		_ = f.admin.Close()
	})
	for _, role := range []string{f.owner, f.runtime, f.retention, f.reader} {
		login := "LOGIN"
		if role == f.owner {
			login = "NOLOGIN"
		}
		if _, err := f.admin.ExecContext(t.Context(), "CREATE ROLE "+pgx.Identifier{role}.Sanitize()+" "+login+" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.admin.ExecContext(t.Context(), "CREATE SCHEMA "+pgx.Identifier{f.schema}.Sanitize()+" AUTHORIZATION "+pgx.Identifier{f.owner}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.ExecContext(t.Context(), "GRANT TEMPORARY ON DATABASE "+pgx.Identifier{config.Database}.Sanitize()+" TO "+pgx.Identifier{f.runtime}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	connection := func(role string) string {
		c := config.Copy()
		c.RuntimeParams["search_path"] = f.schema
		if role == f.owner {
			c.RuntimeParams["role"] = role
		} else {
			c.User = role
			c.Password = ""
		}
		// ConnString retains the original connection string, not edits to
		// ConnConfig. Use a URL carrying the intended test identity explicitly.
		return rolesConnectionString(c)
	}
	f.ownerDSN, f.runtimeDSN = connection(f.owner), connection(f.runtime)
	f.retentionDSN, f.readerDSN = connection(f.retention), connection(f.reader)
	s, err := postgres.New(t.Context(), f.ownerDSN, f.namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	canonical, err := postgresx.NewWithNamespace(t.Context(), f.ownerDSN, f.namespace)
	if err != nil {
		t.Fatalf("canonical bootstrap must coexist with all operational tables: %v", err)
	}
	if err := canonical.Close(); err != nil {
		t.Fatal(err)
	}
	for _, script := range []string{"operational-grants.sql", "canonical-grants.sql"} {
		cmd := exec.CommandContext(t.Context(), "psql", "-X", "--dbname", endpoint, "-v", "ON_ERROR_STOP=1", // #nosec G204 G702 -- Checked-in grants and random fixture roles on an explicitly loopback test database.
			"-v", "schema="+f.schema, "-v", "runtime="+f.runtime, "-v", "retention="+f.retention, "-v", "reader="+f.reader,
			"-f", "../../postgres/"+script)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("apply %s: %v\n%s", script, err, output)
		}
	}
	return f
}
