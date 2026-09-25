package ingest

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestEmptyRedisRebuildAndFailedReplacementPreservesActiveGeneration(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := redisx.New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := redisx.NormalizeNamespace("recovery-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	store := redisx.NewStore(client, namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	before, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if before.Generation != "" {
		t.Fatalf("new projection namespace unexpectedly has active data: %#v", before)
	}

	result, err := Run(ctx, store, "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Generation == "" || result.Revision != 1 || len(result.Counts) == 0 {
		t.Fatalf("empty Redis was not rebuilt into a valid active generation: %#v", result)
	}

	if _, err := Run(ctx, store, t.TempDir(), Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	}); err == nil {
		t.Fatal("expected rebuild from an invalid authoritative source to fail")
	}
	after, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.Generation != result.Generation || after.Revision != result.Revision {
		t.Fatalf("failed rebuild replaced active generation: before=%#v after=%#v", result, after)
	}
}
