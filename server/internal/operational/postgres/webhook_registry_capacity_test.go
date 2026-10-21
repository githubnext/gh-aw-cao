package postgres

import (
	"errors"
	"reflect"
	"testing"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func TestWebhookRegistryExpandedFleetCapacity(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	control := webhookPolicy()
	initial, err := q.BindRegistry(t.Context(), control)
	if err != nil {
		t.Fatal(err)
	}
	records := make([]wg.RepositoryInventory, wg.MaxDiscoveryRepositories, wg.MaxDiscoveryRepositories+1)
	for i := range records {
		records[i] = wg.RepositoryInventory{RepositoryID: int64(i + 1)}
	}
	published, err := q.ReplaceRegistry(t.Context(), control, initial.Version, records)
	if err != nil || len(published.Records) != len(records) {
		t.Fatal("durable registry rejected the expanded bounded fleet", err)
	}
	restored, err := q.BindRegistry(t.Context(), control)
	if err != nil || !reflect.DeepEqual(restored, published) {
		t.Fatal("durable registry could not read back the expanded fleet", err)
	}
	records = append(records, wg.RepositoryInventory{RepositoryID: int64(len(records) + 1)})
	if _, err := q.ReplaceRegistry(t.Context(), control, published.Version, records); !errors.Is(err, wg.ErrInvalid) {
		t.Fatal("durable registry accepted over-limit enrollment", err)
	}
}
