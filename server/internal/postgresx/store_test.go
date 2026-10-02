package postgresx

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestDecodeJSONPreservesNumbers(t *testing.T) {
	var row map[string]any
	if err := decodeJSON([]byte(`{"id":9007199254740993}`), &row); err != nil {
		t.Fatal(err)
	}
	if row["id"] != json.Number("9007199254740993") {
		t.Fatalf("number lost precision: %#v", row)
	}
}

func TestNamespaceRequired(t *testing.T) {
	if _, err := NewWithNamespace(t.Context(), "postgres://127.0.0.1/postgres?sslmode=disable", ""); err == nil {
		t.Fatal("empty namespace accepted")
	}
}

func TestConnectionTransport(t *testing.T) {
	for _, test := range []struct {
		endpoint string
		valid    bool
	}{
		{"postgres://127.0.0.1/postgres?sslmode=disable", true},
		{"postgres://localhost/postgres?sslmode=disable", true},
		{"postgres://db.example.com/postgres?sslmode=disable", false},
		{"postgres://db.example.com/postgres?sslmode=require", true},
	} {
		config, err := pgx.ParseConfig(test.endpoint)
		if err != nil {
			t.Fatal(err)
		}
		if valid := validateTransport(config) == nil; valid != test.valid {
			t.Errorf("transport accepted=%t want=%t", valid, test.valid)
		}
	}
}

func TestRejectsInsecureDSNWithoutLeakingCredentials(t *testing.T) {
	_, err := New(context.Background(), "postgres://operator:secret@example.com/postgres?sslmode=disable")
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe transport failure: %v", err)
	}
}

func TestPartitionMaintenanceRunsOnDailyTicks(t *testing.T) {
	if partitionMaintenanceInterval != 24*time.Hour {
		t.Fatalf("partition maintenance interval = %s", partitionMaintenanceInterval)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ticks := make(chan time.Time)
	calls := make(chan time.Time, 2)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPartitionMaintenanceLoop(ctx, ticks, func(_ context.Context, at time.Time) error {
			calls <- at
			return nil
		})
	}()
	first := time.Date(2026, time.October, 2, 0, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{first, first.Add(partitionMaintenanceInterval)} {
		select {
		case ticks <- at:
		case <-time.After(time.Second):
			t.Fatal("maintenance loop did not accept daily tick")
		}
		select {
		case called := <-calls:
			if !called.Equal(at) {
				t.Fatalf("maintenance ran for %s, want %s", called, at)
			}
		case <-time.After(time.Second):
			t.Fatal("maintenance did not run on daily tick")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("maintenance loop did not stop")
	}
}
