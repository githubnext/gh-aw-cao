package ingest

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/dashboarddb"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type failFirstRowBatch struct {
	*redisx.Client
}

type ageFirstGeneration struct {
	*redisx.Client
	registryWrites int
}

func (client *ageFirstGeneration) Do(ctx context.Context, command ...string) (any, error) {
	if len(command) >= 4 && command[0] == "ZADD" && strings.HasSuffix(command[1], ":generations") {
		client.registryWrites++
		if client.registryWrites == 1 {
			command[2] = "1"
		}
	}
	return client.Client.Do(ctx, command...)
}

func (client failFirstRowBatch) DoMany(ctx context.Context, commands [][]string) ([]any, error) {
	if len(commands) != 0 && len(commands[0]) > 1 && strings.Contains(commands[0][1], "JSON.SET") {
		return nil, errors.New("injected row write failure")
	}
	return client.Client.DoMany(ctx, commands)
}

func TestGenerationGraceStartsAtActivation(t *testing.T) {
	ctx, _, client, namespace := ingestTestStore(t, "generation-grace")
	aging := &ageFirstGeneration{Client: client}
	store := redisx.NewStore(aging, namespace)
	_, err := Run(ctx, dashboarddb.NewRedisWithRetention(store, 1), "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if aging.registryWrites != 2 {
		t.Fatalf("generation registered %d times, want staging and activation", aging.registryWrites)
	}
	active, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	score, err := client.Do(ctx, "ZSCORE", namespace+":generations", active.Generation)
	if err != nil {
		t.Fatal(err)
	}
	milliseconds, err := strconv.ParseInt(fmt.Sprint(score), 10, 64)
	if err != nil || milliseconds < time.Now().Add(-time.Minute).UnixMilli() {
		t.Fatalf("generation grace was not refreshed before activation: %v %v", score, err)
	}
}

func TestFailedProjectionDiscardsJSONIndexes(t *testing.T) {
	ctx, _, client, namespace := ingestTestStore(t, "failed-json")
	store := redisx.NewStore(failFirstRowBatch{client}, namespace)
	if _, err := Run(ctx, dashboarddb.NewRedis(store), "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	}); err == nil {
		t.Fatal("expected staged row write to fail")
	}
	active, err := store.Active(ctx)
	if err != nil || active.Generation != "" {
		t.Fatalf("failed projection was activated: %+v %v", active, err)
	}
	registered, err := client.Do(ctx, "ZCARD", namespace+":generations")
	if err != nil || registered != int64(0) {
		t.Fatalf("failed generation remained registered: %v %v", registered, err)
	}
	if count := keyCount(ctx, t, client, namespace+":g:*"); count != 0 {
		t.Fatalf("failed generation left %d keys", count)
	}
	indexes, err := client.Do(ctx, "FT._LIST")
	if err != nil {
		t.Fatal(err)
	}
	names, err := redisx.Strings(indexes)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if strings.HasPrefix(name, namespace+":g:") {
			t.Fatalf("failed generation left an index: %s", name)
		}
	}
}

// Every projection writes a complete new generation. Without reclamation a
// deployment that projects frequently exhausts a NoEviction Redis, so this
// asserts that repeated projections leave a bounded keyspace behind.
func TestRepeatedProjectionsReclaimSupersededGenerations(t *testing.T) {
	ctx, store, client, namespace := ingestTestStore(t, "reclaim")
	generations := make([]string, 0, 4)
	for attempt := 0; attempt < 4; attempt++ {
		_, err := Run(ctx, dashboarddb.NewRedis(store), "../../testdata/deployed-subset", Options{
			DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
			Force:               true,
		})
		if err != nil {
			t.Fatal(err)
		}
		active, err := store.Active(ctx)
		if err != nil {
			t.Fatal(err)
		}
		generations = append(generations, active.Generation)
	}
	// Activation must register every generation it writes; otherwise nothing
	// could ever find a superseded generation to reclaim.
	registered, err := client.Do(ctx, "ZCARD", namespace+":generations")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(registered) != strconv.Itoa(len(generations)) {
		t.Fatalf("registry holds %v generations, want %d", registered, len(generations))
	}
	// Reclamation honours a grace period so in-flight readers finish.
	// Backdating simulates that period having elapsed.
	for index, generation := range generations {
		if _, err := client.Do(ctx, "ZADD", namespace+":generations", "XX", strconv.Itoa(index+1), generation); err != nil {
			t.Fatal(err)
		}
	}
	dropped, err := store.PruneGenerations(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != len(generations)-1 {
		t.Fatalf("reclaimed %d generations, want %d", dropped, len(generations)-1)
	}
	active := generations[len(generations)-1]
	for _, generation := range generations[:len(generations)-1] {
		if keyCount(ctx, t, client, namespace+":g:"+generation+"*") != 0 {
			t.Fatalf("superseded generation %s was not reclaimed", generation)
		}
	}
	if keyCount(ctx, t, client, namespace+":g:"+active+"*") == 0 {
		t.Fatal("active generation was reclaimed")
	}
	source, _, err := store.LoadSource(ctx, active, "repositories", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(source.Rows) == 0 {
		t.Fatal("active generation lost its rows")
	}
}

// The active generation must survive reclamation even when the retention count
// would otherwise select it, because dropping it would empty the dashboard.
func TestReclamationNeverDropsTheActiveGeneration(t *testing.T) {
	ctx, store, client, namespace := ingestTestStore(t, "reclaim-active")
	_, err := Run(ctx, dashboarddb.NewRedis(store), "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	})
	if err != nil {
		t.Fatal(err)
	}
	active, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(ctx, "ZADD", namespace+":generations", "1", active.Generation); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PruneGenerations(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if keyCount(ctx, t, client, namespace+":g:"+active.Generation+"*") == 0 {
		t.Fatal("active generation was reclaimed")
	}
}

// A projection over an unchanged lake must reuse the active generation. The
// collection profile projects on a short interval and most collections add
// nothing, so without this short-circuit steady state would be a full rewrite.
func TestUnchangedLakeReusesTheActiveGeneration(t *testing.T) {
	ctx, store, _, _ := ingestTestStore(t, "unchanged")
	options := Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
	}
	first, err := Run(ctx, dashboarddb.NewRedis(store), "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Run(ctx, dashboarddb.NewRedis(store), "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != first.Revision {
		t.Fatalf("unchanged lake advanced the revision to %d, want %d", second.Revision, first.Revision)
	}
}

func ingestTestStore(t *testing.T, label string) (context.Context, *redisx.Store, *redisx.Client, string) {
	t.Helper()
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := redisx.New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := redisx.NormalizeNamespace(label + "-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	return ctx, redisx.NewStore(client, namespace), client, namespace
}

func keyCount(ctx context.Context, t *testing.T, client *redisx.Client, pattern string) int {
	t.Helper()
	cursor := "0"
	total := 0
	for {
		value, err := client.Do(ctx, "SCAN", cursor, "MATCH", pattern, "COUNT", "500")
		if err != nil {
			t.Fatal(err)
		}
		page, ok := value.([]any)
		if !ok || len(page) != 2 {
			t.Fatalf("unexpected SCAN reply %T", value)
		}
		cursor = fmt.Sprint(page[0])
		keys, _ := page[1].([]any)
		total += len(keys)
		if cursor == "0" {
			return total
		}
	}
}
