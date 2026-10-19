package webhookgatewayhost

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestLabelConsumptionPostgresReceiptsSurviveRestart(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is required for durable consumption conformance")
	}
	namespace := "label-test-" + gateway.MetadataDigest([]byte(t.Name() + time.Now().String()))[:24]
	store, err := postgres.New(t.Context(), dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := store.DeleteNamespace(ctx); err != nil {
			t.Error(err)
		}
		_ = store.Close()
	})
	_, job, consumer, api := labelConsumerFixture(t)
	consumer.Deliveries, consumer.Receipts = store, store
	if err := consumer.ConsumeLabels(t.Context(), []gateway.Job{job}); err != nil {
		t.Fatal(err)
	}
	reopened, err := postgres.Open(t.Context(), dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	consumer.Deliveries, consumer.Receipts = reopened, reopened
	if err := consumer.ConsumeLabels(t.Context(), []gateway.Job{job}); err != nil || api.writes != 1 {
		t.Fatal("restart repeated label consumption", err)
	}
	if err := reopened.SetExpiringOperationalState(t.Context(), "expiry-check", []byte("receipt"), time.Millisecond); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	receipt, err := reopened.OperationalState(t.Context(), "expiry-check")
	if err != nil || len(receipt) != 0 {
		t.Fatal("expired receipt remained live", err)
	}
}
