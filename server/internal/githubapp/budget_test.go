package githubapp

import (
	"context"
	"errors"
	"testing"
	"time"
)

type memoryBudgetStore struct {
	values map[string]string
}

func newMemoryBudgetStore() *memoryBudgetStore {
	return &memoryBudgetStore{values: map[string]string{}}
}

func (s *memoryBudgetStore) HashGet(_ context.Context, key, field string) (string, error) {
	return s.values[key+"/"+field], nil
}

func (s *memoryBudgetStore) HashSet(_ context.Context, key, field, value string) error {
	s.values[key+"/"+field] = value
	return nil
}

func TestBudgetRefusesToSpendBelowTheFloor(t *testing.T) {
	store := newMemoryBudgetStore()
	budget := Budget{Store: store, Floor: 1000, Cost: 500}
	ctx := context.Background()
	reset := time.Now().Add(time.Hour)
	if err := budget.Observe(ctx, 7, 900, reset); err != nil {
		t.Fatal(err)
	}
	if _, err := budget.Reserve(ctx, 7); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("expected an exhausted budget, got %v", err)
	}
	if err := budget.Observe(ctx, 7, 4000, reset); err != nil {
		t.Fatal(err)
	}
	reserve, err := budget.Reserve(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	if reserve != 1000 {
		t.Fatalf("reserve = %d, want the configured floor 1000", reserve)
	}
	remaining, _, err := budget.Headroom(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	if remaining != 3500 {
		t.Fatalf("remaining = %d, want 3500 after one reservation", remaining)
	}
}

func TestBudgetParksAnInstallation(t *testing.T) {
	store := newMemoryBudgetStore()
	budget := Budget{Store: store, Floor: 100, Cost: 10}
	ctx := context.Background()
	if err := budget.Observe(ctx, 3, 5000, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := budget.Park(ctx, 3, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := budget.Reserve(ctx, 3); !errors.Is(err, ErrInstallationParked) {
		t.Fatalf("expected a parked installation, got %v", err)
	}
	_, parkedUntil, err := budget.Headroom(ctx, 3)
	if err != nil {
		t.Fatal(err)
	}
	if parkedUntil.IsZero() {
		t.Fatal("expected a park expiry to be recorded")
	}
	// An expired park lets work resume without external intervention.
	if err := budget.Park(ctx, 3, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := budget.Reserve(ctx, 3); err != nil {
		t.Fatalf("expected an expired park to release the installation, got %v", err)
	}
}

func TestBudgetIsolatesInstallations(t *testing.T) {
	store := newMemoryBudgetStore()
	budget := Budget{Store: store, Floor: 100, Cost: 10}
	ctx := context.Background()
	if err := budget.Observe(ctx, 1, 200, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := budget.Park(ctx, 1, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := budget.Observe(ctx, 2, 5000, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := budget.Reserve(ctx, 2); err != nil {
		t.Fatalf("one parked installation must not block another: %v", err)
	}
}

func TestBudgetRequiresAStore(t *testing.T) {
	if _, err := (Budget{}).Reserve(context.Background(), 1); err == nil {
		t.Fatal("expected the governor to fail closed without a store")
	}
}

func TestConfigValidationRejectsIncompleteCredentials(t *testing.T) {
	cases := []Config{
		{},
		{AppID: 1},
		{PrivateKeyPEM: []byte("key")},
	}
	for _, config := range cases {
		if err := config.Validate(); err == nil {
			t.Fatalf("expected %+v to be rejected", config)
		}
	}
}
