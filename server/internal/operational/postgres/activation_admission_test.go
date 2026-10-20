package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

func TestActivationAdmissionReplicaRetryAndRevocation(t *testing.T) {
	store, dsn := testStore(t, Config{})
	replica, err := Open(t.Context(), dsn, store.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = replica.Close() }()
	key := strings.Repeat("a", 64)
	detection, evals := int32(100), int32(50)
	first := admission.Allowances{Primary: 1000, ThreatDetection: &detection, Evals: &evals}
	if _, err := store.ResolveAdmission(t.Context(), key, &first); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for n := 0; n < 20; n++ {
		wg.Go(func() {
			changed := admission.Allowances{Primary: 2000}
			actual, err := replica.ResolveAdmission(t.Context(), key, &changed)
			if err != nil || actual.Primary != 1000 || actual.ThreatDetection == nil ||
				*actual.ThreatDetection != 100 || actual.Evals == nil || *actual.Evals != 50 {
				t.Errorf("retry changed original response: %+v %v", actual, err)
			}
		})
	}
	wg.Wait()
	// A storage timeout does not erase a committed decision.
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := replica.ResolveAdmission(cancelled, key, &first); !errors.Is(err, admission.ErrUnavailable) {
		t.Fatalf("cancel: %v", err)
	}
	if actual, err := replica.ResolveAdmission(t.Context(), key, &first); err != nil || actual.Primary != 1000 {
		t.Fatalf("recovery: %+v %v", actual, err)
	}
	if _, err := replica.ResolveAdmission(t.Context(), key, nil); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := store.ResolveAdmission(t.Context(), key, &first); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("revocation was renewed: %v", err)
	}
	if err := replica.CheckAdmission(t.Context(), key); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("revoked check: %v", err)
	}
	if _, err := store.ResolveAdmission(t.Context(), strings.Repeat("b", 64), &first); err != nil {
		t.Fatalf("independent invocation: %v", err)
	}
}

func TestActivationAdmissionNonSlidingExpiryAndCapacity(t *testing.T) {
	store, _ := testStore(t, Config{MaxProtectedEntries: 2})
	key := strings.Repeat("c", 64)
	allowance := admission.Allowances{Primary: 1}
	if _, err := store.ResolveAdmission(t.Context(), key, &allowance); err != nil {
		t.Fatal(err)
	}
	var committedExpiry time.Time
	err := store.transact(t.Context(), func(tx *transaction) error {
		k := keyForActivation(key)
		var record activationDecision
		if _, err := tx.json(k, &record); err != nil {
			return err
		}
		committedExpiry = record.ExpiresAt
		if record.ExpiresAt.Sub(tx.now) < 4*time.Minute || record.ExpiresAt.Sub(tx.now) > 5*time.Minute {
			t.Errorf("retry horizon: %s", record.ExpiresAt.Sub(tx.now))
		}
		record.ExpiresAt = tx.now.Add(-time.Second)
		return tx.putJSON(k, record, time.Time{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveAdmission(t.Context(), key, &allowance); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("expiry regranted: %v", err)
	}
	if err := store.CheckAdmission(t.Context(), key); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("expired check: %v", err)
	}
	err = store.transact(t.Context(), func(tx *transaction) error {
		var record activationDecision
		_, err := tx.json(keyForActivation(key), &record)
		if !record.ExpiresAt.Before(committedExpiry) || !record.Revoked {
			t.Error("expiry slid forward")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveAdmission(t.Context(), strings.Repeat("d", 64), &allowance); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveAdmission(t.Context(), strings.Repeat("e", 64), &allowance); !errors.Is(err, admission.ErrUnavailable) {
		t.Fatalf("capacity: %v", err)
	}
	if _, err := store.ResolveAdmission(t.Context(), key, &allowance); !errors.Is(err, admission.ErrDenied) {
		t.Fatalf("capacity evicted denial: %v", err)
	}
}

func keyForActivation(name string) key { return key{"activation-admission", name, ""} }
