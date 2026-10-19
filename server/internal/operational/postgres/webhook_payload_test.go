package postgres

import (
	"bytes"
	"reflect"
	"testing"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestWebhookPersistsOnlyCompiledPayloadAndTrustedIdentity(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	subscription := webhookJob("one", "tenant").Subscription
	path := "/approved"
	subscription.Destination.Fields = []wg.PayloadField{{Name: "approved", Path: &path, Required: true}}
	raw := []byte(`{"installation":{"id":10},"repository":{"id":20},"approved":"safe","secret":"sensitive-value-must-not-be-retained"}`)
	event, err := wg.ParseEvent("delivery", "issues", raw, wg.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = "source"
	job, err := wg.NewJob(time.Now().Add(-time.Second), "prepared", event, subscription, webhookJob("one", "tenant").SubscriptionDigest)
	if err != nil {
		t.Fatal(err)
	}
	result, err := q.AdmitBatch(t.Context(), wg.Admission{
		Revision: webhookPolicy(), DeliveryID: event.DeliveryID, DeliveryDigest: wg.MetadataDigest(raw), Jobs: []wg.Job{job},
	})
	if err != nil || len(result.Jobs) != 1 {
		t.Fatalf("prepared admission: %+v %v", result, err)
	}
	var document []byte
	if err := s.db.QueryRowContext(t.Context(), `SELECT document FROM cao_operational_webhook_jobs WHERE namespace=$1 AND id=$2`, s.namespace, result.Jobs[0].ID).Scan(&document); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(document, []byte("sensitive-value-must-not-be-retained")) || bytes.Contains(document, []byte(`"secret"`)) {
		t.Fatal("raw unapproved event data persisted")
	}
	claimed := claimWebhook(t, q)
	if !reflect.DeepEqual(claimed.Event, wg.IdentityOf(event)) || !bytes.Contains(claimed.Payload, []byte(`"approved":"safe"`)) {
		t.Fatalf("trusted identity or compiled payload lost: %+v", claimed.Event)
	}
	dispatchWebhook(t, q, claimed)
}
