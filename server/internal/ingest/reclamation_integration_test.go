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

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type failFirstRowBatch struct{ *redisx.Client }

func (client failFirstRowBatch) DoMany(ctx context.Context, commands [][]string) ([]any, error) {
	if len(commands) > 0 && commands[0][0] == "EVAL" &&
		strings.Contains(commands[0][1], `redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])`) {
		return nil, errors.New("injected row write failure")
	}
	return client.Client.DoMany(ctx, commands)
}

func TestFailedProjectionLeavesPublishedDatasetAndNoStagingKeys(t *testing.T) {
	ctx, store, client, namespace := ingestTestStore(t, "failed-projection")
	options := Options{DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json"}
	first, err := Run(ctx, store, "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	failing := redisx.NewStore(failFirstRowBatch{client}, namespace)
	options.Force = true
	if _, err := Run(ctx, failing, "../../testdata/deployed-subset", options); err == nil {
		t.Fatal("expected injected row write failure")
	}
	active, err := store.Active(ctx)
	if err != nil || active.Revision != first.Revision {
		t.Fatalf("failed projection changed dataset: %+v %v", active, err)
	}
	if count := keyCount(ctx, t, client, namespace+":staging:*"); count != 0 {
		t.Fatalf("failed projection leaked %d staging keys", count)
	}
}

func TestRepeatedProjectionsReplaceDatasetWithoutAccumulation(t *testing.T) {
	ctx, store, client, namespace := ingestTestStore(t, "replace")
	options := Options{DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json", Force: true}
	baseline := -1
	for attempt := 0; attempt < 4; attempt++ {
		result, err := Run(ctx, store, "../../testdata/deployed-subset", options)
		if err != nil {
			t.Fatal(err)
		}
		if result.Revision != int64(attempt+1) {
			t.Fatalf("revision = %d", result.Revision)
		}
		count := keyCount(ctx, t, client, namespace+":dataset*")
		if baseline < 0 {
			baseline = count
		} else if count != baseline {
			t.Fatalf("dataset keys grew from %d to %d", baseline, count)
		}
		if count := keyCount(ctx, t, client, namespace+":staging:*"); count != 0 {
			t.Fatalf("projection leaked %d staging keys", count)
		}
	}
}

func TestUnchangedLakeReusesPublishedDataset(t *testing.T) {
	ctx, store, _, _ := ingestTestStore(t, "unchanged")
	options := Options{DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json"}
	first, err := Run(ctx, store, "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Run(ctx, store, "../../testdata/deployed-subset", options)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != second.Revision {
		t.Fatalf("unchanged dataset advanced revision: %d to %d", first.Revision, second.Revision)
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
