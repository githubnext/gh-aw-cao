package server

import (
	"bufio"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// TestSSEFanoutMeasurements compares connected-stream cost across process-local
// replicas. Run with POSTGRES_URL and CAO_SSE_MEASURE=1 against disposable data.
func TestSSEFanoutMeasurements(t *testing.T) {
	if os.Getenv("CAO_SSE_MEASURE") != "1" {
		t.Skip("set CAO_SSE_MEASURE=1 and POSTGRES_URL for the SSE measurement")
	}
	database := integrationDatabase(t)
	admin, err := sql.Open("pgx", os.Getenv("POSTGRES_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close() }()
	address, closeRedis := fakeRedis(t)
	defer closeRedis()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	for _, replicas := range []int{1, 2} {
		servers := make([]*httptest.Server, replicas)
		apps := make([]*App, replicas)
		for i := range servers {
			apps[i] = &App{
				store: redisx.NewStore(client, "sse-measure"), hub: newEventHub(),
				database: database, drain: make(chan struct{}),
				config: Config{HostProfile: localHostProfile()}, accessToken: testAccessToken,
			}
			servers[i] = httptest.NewServer(apps[i].Handler())
		}
		for _, perReplica := range []int{1, 12} {
			streams := make([]*http.Response, 0, replicas*perReplica)
			transport := &http.Transport{MaxIdleConnsPerHost: replicas * perReplica}
			httpClient := &http.Client{Transport: transport, Timeout: 10 * time.Second}
			for _, server := range servers {
				for range perReplica {
					req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/api/v1/events", nil)
					if err != nil {
						t.Fatal(err)
					}
					req.Header.Set("Authorization", "Bearer "+testAccessToken)
					resp, err := httpClient.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := bufio.NewReader(resp.Body).ReadString('\n'); err != nil {
						t.Fatal(err)
					}
					streams = append(streams, resp)
				}
			}
			runtime.GC()
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			var start, end int64
			if err := admin.QueryRowContext(t.Context(), "SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()").Scan(&start); err != nil {
				t.Fatal(err)
			}
			time.Sleep(4 * time.Second)
			// PostgreSQL flushes per-backend statistics asynchronously.
			time.Sleep(time.Second)
			if err := admin.QueryRowContext(t.Context(), "SELECT pg_stat_clear_snapshot()").Err(); err != nil {
				t.Fatal(err)
			}
			if err := admin.QueryRowContext(t.Context(), "SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()").Scan(&end); err != nil {
				t.Fatal(err)
			}
			var connections int
			if err := admin.QueryRowContext(t.Context(), "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()").Scan(&connections); err != nil {
				t.Fatal(err)
			}
			runtime.ReadMemStats(&after)
			drainStart := time.Now()
			for _, resp := range streams {
				_ = resp.Body.Close()
			}
			t.Logf("replicas=%d clients=%d connections=%d transactions_per_second=%.1f heap_before=%d heap_after=%d close_duration=%s",
				replicas, replicas*perReplica, connections, float64(end-start)/5, before.HeapAlloc, after.HeapAlloc, time.Since(drainStart))
			transport.CloseIdleConnections()
		}
		drainStart := time.Now()
		for _, app := range apps {
			app.Drain()
		}
		for _, server := range servers {
			server.Close()
		}
		t.Logf("replicas=%d drain_duration=%s", replicas, time.Since(drainStart))
	}
}
