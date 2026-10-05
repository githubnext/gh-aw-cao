package redisx

import (
	"math"
	"testing"
)

func TestEffectiveMaxMemoryBytes(t *testing.T) {
	for _, test := range []struct {
		configured int64
		provider   int64
		expected   int64
	}{
		{200_000_000, 0, 200_000_000},
		{200_000_000, 100_000_000, 80_000_000},
		{200_000_000, 1_000_000_000, 200_000_000},
		{math.MaxInt64, math.MaxInt64, 7_378_697_629_483_820_645},
	} {
		store := NewStore(nil, "memory-budget")
		if err := store.SetMaxMemoryBytes(test.configured); err != nil {
			t.Fatal(err)
		}
		budget, err := store.EffectiveMaxMemoryBytes(test.provider)
		if err != nil || budget != test.expected {
			t.Fatalf("configured=%d provider=%d budget=%d expected=%d err=%v",
				test.configured, test.provider, budget, test.expected, err)
		}
	}
	store := NewStore(nil, "memory-budget")
	for _, invalid := range []int64{-1, 1} {
		if _, err := store.EffectiveMaxMemoryBytes(invalid); err == nil {
			t.Fatalf("invalid provider limit accepted: %d", invalid)
		}
	}
}
