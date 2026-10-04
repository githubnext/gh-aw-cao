package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestRedisMaxBytesConfiguration(t *testing.T) {
	t.Setenv("CAO_REDIS_MAX_BYTES", "")
	if err := os.Unsetenv("CAO_REDIS_MAX_BYTES"); err != nil {
		t.Fatal(err)
	}
	if maximum, err := redisMaxBytesFromEnv(0); err != nil || maximum != 200_000_000 {
		t.Fatalf("default budget: %d, %v", maximum, err)
	}
	t.Setenv("CAO_REDIS_MAX_BYTES", "200000000")
	if maximum, err := redisMaxBytesFromEnv(0); err != nil || maximum != 200_000_000 {
		t.Fatalf("default-sized budget: %d, %v", maximum, err)
	}
	for _, invalid := range []string{"", "0", "-1", "200MB", "9223372036854775808"} {
		t.Setenv("CAO_REDIS_MAX_BYTES", invalid)
		if _, err := redisMaxBytesFromEnv(0); err == nil {
			t.Fatalf("invalid environment budget accepted: %q", invalid)
		}
		if maximum, err := redisMaxBytesFromEnv(4096); err != nil || maximum != 4096 {
			t.Fatalf("environment overrides explicit config: %d, %v", maximum, err)
		}
	}
	if _, err := redisMaxBytesFromEnv(-1); err == nil {
		t.Fatal("negative configuration accepted")
	}
}

func TestServerAppliesRedisMemoryConfiguration(t *testing.T) {
	t.Setenv("CAO_REDIS_MAX_BYTES", "8000000")
	t.Setenv("CAO_QUERY_CACHE_DISABLED", "false")
	t.Setenv("CAO_QUERY_CACHE_MAX_BYTES", "67108864")
	t.Setenv("CAO_QUERY_CACHE_MAX_RESULT_BYTES", "1048576")
	for _, explicit := range []int64{0, 4_000_000} {
		store := redisx.NewStore(redisMaintenanceClient{}, "memory-config")
		app, err := New(t.Context(), store, Config{
			Database: &postgresx.Store{}, Listen: "127.0.0.1:8443",
			SiteDirectory: t.TempDir(), AccessToken: strings.Repeat("x", 32),
			RedisMaxBytes: explicit,
		})
		if err != nil {
			t.Fatal(err)
		}
		expected := explicit
		if expected == 0 {
			expected = 8_000_000
		}
		if app.config.RedisMaxBytes != expected || store.MaxMemoryBytes() != expected {
			t.Fatalf("server/store budget mismatch: app=%d store=%d expected=%d",
				app.config.RedisMaxBytes, store.MaxMemoryBytes(), expected)
		}
	}
}

type redisMaintenanceClient struct {
	err   error
	calls chan time.Duration
}

func (client redisMaintenanceClient) Do(ctx context.Context, command ...string) (any, error) {
	if deadline, ok := ctx.Deadline(); ok && client.calls != nil {
		select {
		case client.calls <- time.Until(deadline):
		default:
		}
	}
	if client.err != nil {
		return nil, client.err
	}
	if strings.Contains(command[1], "return {used, budget, evicted}") {
		return []any{int64(1024), int64(200_000_000), int64(0)}, nil
	}
	return []any{nil, int64(0), int64(0), int64(0), int64(0)}, nil
}

func (redisMaintenanceClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, errors.New("unexpected maintenance pipeline")
}

func maintenanceApp(client redisMaintenanceClient, output io.Writer) *App {
	return &App{
		store: redisx.NewStore(client, "maintenance"),
		config: Config{
			QueryCache: QueryCacheConfig{MaxBytes: 64 << 20},
			Logger:     log.New(output, "", 0),
		},
	}
}

func TestRedisMaintenanceStartsAndStopsWithService(t *testing.T) {
	client := redisMaintenanceClient{calls: make(chan time.Duration, 8)}
	app := maintenanceApp(client, io.Discard)
	if err := app.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case remaining := <-client.calls:
		if remaining <= 0 || remaining > redisMaintenanceTimeout {
			t.Fatalf("unbounded startup maintenance: %s", remaining)
		}
	default:
		t.Fatal("startup did not run Redis maintenance")
	}
	stopCtx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := app.Stop(stopCtx); err != nil {
		t.Fatalf("maintenance outlived service stop: %v", err)
	}
}

func TestRedisMaintenancePeriodicAndCancellation(t *testing.T) {
	client := redisMaintenanceClient{calls: make(chan time.Duration, 8)}
	app := maintenanceApp(client, io.Discard)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.runRedisMaintenance(ctx, time.Millisecond)
	}()
	select {
	case <-client.calls:
	case <-time.After(time.Second):
		t.Fatal("periodic maintenance did not run")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("maintenance did not stop on cancellation")
	}
}

func TestRedisMaintenanceFailuresAreExplicitAndSanitized(t *testing.T) {
	var output bytes.Buffer
	app := maintenanceApp(redisMaintenanceClient{err: errors.New("private backend error")}, &output)
	if err := app.Start(t.Context()); err == nil || strings.Contains(err.Error(), "private") {
		t.Fatalf("startup error was hidden or exposed backend details: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	app.runRedisMaintenance(ctx, time.Millisecond)
	if !strings.Contains(output.String(), "Redis cache maintenance failed") || strings.Contains(output.String(), "private") {
		t.Fatalf("periodic error was hidden or exposed backend details: %q", output.String())
	}
	if app.startContext != nil {
		t.Fatal("failed startup became active")
	}
}

func TestAzureRedisMaintenanceStopsOnDrain(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	handler := &azureFunctionsHandler{app: &App{}, stopMaintenance: cancel}
	handler.Drain()
	if ctx.Err() == nil {
		t.Fatal("platform maintenance outlived drain")
	}
}
