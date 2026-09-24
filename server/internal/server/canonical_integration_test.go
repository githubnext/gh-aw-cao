package server

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestCanonicalAPIQueriesMatchActiveRedisGeneration(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := redisx.New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := redisx.NormalizeNamespace("canonical-api-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	store := redisx.NewStore(client, namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := ingest.Run(ctx, store, "../../testdata/deployed-subset", ingest.Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		Force:               true,
	})
	if err != nil {
		t.Fatal(err)
	}
	service := canonicalService{store: store}
	repositories, err := service.rows(ctx, "repositories")
	if err != nil {
		t.Fatal(err)
	}
	direct, _, err := store.LoadSource(ctx, result.Generation, "repositories", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories) != len(direct.Rows) || len(repositories) == 0 {
		t.Fatalf("canonical API and Redis generation differ: api=%d redis=%d", len(repositories), len(direct.Rows))
	}
	id := fmt.Sprint(repositories[0]["id"])
	repository, err := service.entity(ctx, "repositories", id)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(repository["id"]) != id {
		t.Fatalf("canonical entity query returned the wrong repository: %#v", repository)
	}
	if _, err := service.repositoryRuns(ctx, id); err != nil {
		t.Fatal(err)
	}
}
