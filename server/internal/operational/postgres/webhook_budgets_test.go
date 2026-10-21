package postgres

import (
	"errors"
	"testing"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func TestWebhookScopedRowsAndBytes(t *testing.T) {
	for _, dimension := range []string{"tenant", "source", "destination"} {
		t.Run(dimension+"-rows", func(t *testing.T) {
			s, _ := testStore(t, Config{})
			options := webhookOptions()
			switch dimension {
			case "tenant":
				options.MaxTenantRows = 2
			case "source":
				options.MaxSourceRows = 2
			case "destination":
				options.MaxDestinationRows = 1
			}
			q := openWebhook(t, s, options)
			admitWebhook(t, q, "first", webhookJob("one", "tenant"))
			if _, err := q.AdmitBatch(t.Context(), webhookAdmission("second", webhookJob("two", "tenant"))); !errors.Is(err, wg.ErrCapacity) {
				t.Fatalf("scope capacity: %v", err)
			}
		})
		t.Run(dimension+"-bytes", func(t *testing.T) {
			s, _ := testStore(t, Config{})
			options := webhookOptions()
			switch dimension {
			case "tenant":
				options.MaxTenantBytes = 2048
			case "source":
				options.MaxSourceBytes = 2048
			case "destination":
				options.MaxDestinationBytes = 2048
			}
			q := openWebhook(t, s, options)
			if _, err := q.AdmitBatch(t.Context(), webhookAdmission("first", webhookJob("one", "tenant"))); !errors.Is(err, wg.ErrCapacity) {
				t.Fatalf("scope byte capacity: %v", err)
			}
			var receipts int
			if err := s.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_operational_webhook_deliveries WHERE namespace=$1`, s.namespace).Scan(&receipts); err != nil || receipts != 0 {
				t.Fatalf("partial receipt: %d %v", receipts, err)
			}
		})
	}
}

func TestWebhookHierarchicalBudgetsAreAtomic(t *testing.T) {
	for _, dimension := range []string{"global", "app", "tenant", "destination", "workflow"} {
		t.Run(dimension, func(t *testing.T) {
			s, dsn := testStore(t, Config{})
			options := webhookOptions()
			rate := wg.RateBudget{Capacity: 1, Period: time.Hour}
			switch dimension {
			case "global":
				options.Rates.Global = rate
			case "app":
				options.Rates.App = rate
			case "tenant":
				options.Rates.Tenant = rate
			case "destination":
				options.Rates.Destination = rate
			case "workflow":
				options.Rates.Workflow = rate
			}
			q := openWebhook(t, s, options)
			admitWebhook(t, q, "first", webhookJob("one", "tenant"))
			first := dispatchWebhook(t, q, claimWebhook(t, q))
			if _, err := q.Finish(t.Context(), webhookJobFence(first), wg.Outcome{State: wg.Succeeded, AcceptedStatus: 204}); err != nil {
				t.Fatal(err)
			}
			peer, err := Open(t.Context(), dsn, s.namespace, Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = peer.Close() }()
			reopened := openWebhook(t, peer, options)
			admitWebhook(t, reopened, "second", webhookJob("two", "tenant"))
			second := claimWebhook(t, reopened)
			if _, err := reopened.BeginDispatch(t.Context(), webhookJobFence(second), webhookAuthorization(second)); !errors.Is(err, wg.ErrCapacity) {
				t.Fatalf("cross-connection %s budget: %v", dimension, err)
			}
			if err := reopened.store.transact(t.Context(), func(tx *transaction) error {
				current, err := reopened.detail(tx, second.ID)
				if err == nil && (current.State != wg.Claimed || current.Attempt != 0) {
					t.Fatalf("denial changed dispatch: %+v", current)
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWebhookDeniedTenantDoesNotSpendGlobalBudget(t *testing.T) {
	s, _ := testStore(t, Config{})
	options := webhookOptions()
	options.Rates.Global.Capacity = 2
	options.Rates.Tenant.Capacity = 1
	q := openWebhook(t, s, options)
	admitWebhook(t, q, "first", webhookJob("one", "a"))
	first := dispatchWebhook(t, q, claimWebhook(t, q))
	if _, err := q.Finish(t.Context(), webhookJobFence(first), wg.Outcome{State: wg.Succeeded, AcceptedStatus: 204}); err != nil {
		t.Fatal(err)
	}
	admitWebhook(t, q, "second", webhookJob("two", "a"))
	second := claimWebhook(t, q)
	if _, err := q.BeginDispatch(t.Context(), webhookJobFence(second), webhookAuthorization(second)); !errors.Is(err, wg.ErrCapacity) {
		t.Fatalf("tenant budget: %v", err)
	}
	if _, err := q.Finish(t.Context(), webhookJobFence(second), wg.Outcome{State: wg.Ready, NotBefore: time.Now().Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	admitWebhook(t, q, "third", webhookJob("three", "b"))
	third := claimWebhook(t, q)
	dispatchWebhook(t, q, third)
}

func TestWebhookSharedProtectedBudgetRollsBack(t *testing.T) {
	s, _ := testStore(t, Config{MaxProtectedEntries: 3})
	q := openWebhook(t, s, webhookOptions())
	if err := s.WriteAttribute(t.Context(), "existing", "entry", "protected"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AdmitBatch(t.Context(), webhookAdmission("retry", webhookJob("one", "tenant"))); !errors.Is(err, wg.ErrCapacity) {
		t.Fatalf("shared protected budget: %v", err)
	}
	var count int
	if err := s.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_operational_webhook_deliveries WHERE namespace=$1`, s.namespace).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial shared-budget receipt: %d %v", count, err)
	}
}
