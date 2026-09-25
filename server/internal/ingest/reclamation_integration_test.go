package ingest

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

// Every projection writes a complete new generation. Without reclamation a
// deployment that projects frequently exhausts a NoEviction Redis, so this
// asserts that repeated projections leave a bounded keyspace behind.
func TestRepeatedProjectionsReclaimSupersededGenerations(t *testing.T) {
	ctx, store, client, namespace := ingestTestStore(t, "reclaim")
	generations := make([]string, 0, 4)
	for attempt := 0; attempt < 4; attempt++ {
		result, err := Run(ctx, store, "../../testdata/deployed-subset", Options{
			DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
			Force:               true,
			RetainGenerations:   1,
		})
		if err != nil {
			t.Fatal(err)
		}
		generations = append(generations, result.Generation)
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
	result, err := Run(ctx, store, "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(ctx, "ZADD", namespace+":generations", "1", result.Generation); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PruneGenerations(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if keyCount(ctx, t, client, namespace+":g:"+result.Generation+"*") == 0 {
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
	first, err := Run(ctx, store, "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Run(ctx, store, "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Generation != first.Generation {
		t.Fatalf("unchanged lake wrote a new generation %s, want %s", second.Generation, first.Generation)
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
