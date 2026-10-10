package memory

import (
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestClassifyDeliveryReservation(t *testing.T) {
	cases := []struct {
		name                  string
		alreadyCommitted      bool
		reservationInProgress bool
		want                  operational.DeliveryReservation
	}{
		{"neither", false, false, operational.DeliveryReserved},
		{"in-progress-only", false, true, operational.DeliveryInProgress},
		{"committed-only", true, false, operational.DeliveryAlreadyCommitted},
		{"committed-takes-precedence", true, true, operational.DeliveryAlreadyCommitted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyDeliveryReservation(tc.alreadyCommitted, tc.reservationInProgress)
			if got != tc.want {
				t.Fatalf("classifyDeliveryReservation(%t, %t) = %v, want %v",
					tc.alreadyCommitted, tc.reservationInProgress, got, tc.want)
			}
		})
	}
}

// TestReserveDeliveryPrecedence exercises ReserveDelivery's full precedence
// through the real Store: a reservation in progress blocks a second
// reservation attempt, but once the delivery is permanently remembered, that
// takes priority over any further reservation attempt, including on the same
// id after its reservation lapsed.
func TestReserveDeliveryPrecedence(t *testing.T) {
	s, clock := fixture(t, Config{})
	ctx := t.Context()

	result, err := s.ReserveDelivery(ctx, "evt", time.Second)
	must(t, err)
	if result != operational.DeliveryReserved {
		t.Fatalf("first reservation = %v, want DeliveryReserved", result)
	}

	result, err = s.ReserveDelivery(ctx, "evt", time.Second)
	must(t, err)
	if result != operational.DeliveryInProgress {
		t.Fatalf("concurrent reservation = %v, want DeliveryInProgress", result)
	}

	ok, err := s.RememberDelivery(ctx, "evt", time.Minute)
	must(t, err)
	if !ok {
		t.Fatal("RememberDelivery did not commit while a reservation was outstanding")
	}

	result, err = s.ReserveDelivery(ctx, "evt", time.Second)
	must(t, err)
	if result != operational.DeliveryAlreadyCommitted {
		t.Fatalf("reservation after commit = %v, want DeliveryAlreadyCommitted", result)
	}

	clock.Add(2 * time.Second) // the reservation marker expires, the commit marker does not
	result, err = s.ReserveDelivery(ctx, "evt", time.Second)
	must(t, err)
	if result != operational.DeliveryAlreadyCommitted {
		t.Fatalf("reservation after reservation expiry = %v, want DeliveryAlreadyCommitted", result)
	}
	invariant(t, s)
}
